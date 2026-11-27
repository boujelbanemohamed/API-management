import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, Column, CreateDateColumn, Entity, In, Index, IsNull, PrimaryGeneratedColumn, Repository, Unique } from 'typeorm';
import { IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { BankContext, ConsoleGuard, PortalArea, PortalGuard, Section } from '../auth/guards';
import { Bank } from '../portal/bank.decorator';
import { Actor } from '../common/actor.decorator';
import { CLOCK, Clock } from '../common/clock';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.module';
import { Partner, PartnerStatus } from '../partners/partner.entity';
import { Subscription, Environment } from '../subscriptions/subscription.entity';
import { Plan } from '../plans/plan.entity';
import { ApiProduct } from '../apis/api-product.entity';
import { Dispute, DisputeEvent } from '../disputes/dispute.entities';
import { UsageModule } from '../usage/usage.module';
import { UsageService } from '../usage/usage.service';
import { computeLines, dueDateOf, periodBounds, settle, StatementLine, StatementStatus, total } from './billing-rules';

@Entity('statements')
@Unique(['partnerId', 'period'])
export class Statement {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36 }) partnerId: string;
  @Column({ type: 'varchar', length: 7 }) period: string;
  @Column({ type: 'simple-json' }) lines: StatementLine[];
  @Column({ type: 'int' }) total: number;
  @Column({ type: 'int', default: 0 }) paid: number;
  @Column({ type: 'varchar', length: 8, default: 'ISSUED' }) status: StatementStatus;
  @Column({ type: 'varchar', length: 10 }) issuedOn: string;
  @Column({ type: 'varchar', length: 10 }) dueDate: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('payments')
@Index(['partnerId'])
export class Payment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36 }) partnerId: string;
  /** Relevé réglé (null : paiement non rapproché, à affecter). */
  @Column({ type: 'varchar', length: 36, nullable: true }) statementId: string | null;
  @Column({ type: 'int' }) amount: number;
  @Column({ type: 'varchar', length: 60 }) reference: string;
  @Column({ type: 'varchar', length: 10 }) receivedOn: string;
  @Column({ type: 'varchar', length: 120 }) recordedBy: string;
  @CreateDateColumn() createdAt: Date;
}

export class GenerateDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'période au format AAAA-MM' }) period: string;
}

export class PaymentDto {
  @IsUUID() partnerId: string;
  @IsOptional() @IsUUID() statementId?: string;
  @IsInt() @Min(1) amount: number;
  @IsString() @MaxLength(60) reference: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) receivedOn: string;
}

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(Statement) private readonly statements: Repository<Statement>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    @InjectRepository(Subscription) private readonly subs: Repository<Subscription>,
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(ApiProduct) private readonly apis: Repository<ApiProduct>,
    @InjectRepository(Dispute) private readonly disputes: Repository<Dispute>,
    @InjectRepository(DisputeEvent) private readonly events: Repository<DisputeEvent>,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Lignes du relevé d'une banque pour un mois (calcul seul, sans enregistrement). */
  async preview(partner: Partner, period: string): Promise<StatementLine[]> {
    const p = periodBounds(period);
    const [subs, plans, apis] = await Promise.all([
      this.subs.find({ where: { partnerId: partner.id, environment: Environment.PRODUCTION } }),
      this.plans.find(),
      this.apis.find(),
    ]);
    const billable = subs
      .filter((s) => ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'TERMINATED'].includes(s.status))
      .map((s) => {
        const plan = plans.find((x) => x.id === s.planId)!;
        const api = apis.find((x) => x.id === s.apiId)!;
        return { id: s.id, apiId: s.apiId, apiName: api?.name ?? '?', apiSlug: api?.slug ?? '?', planName: plan?.name ?? '?', monthlyFee: plan?.monthlyFee ?? 0, pricePerCall: plan?.pricePerCall ?? 0, startDate: s.startDate, endDate: s.endDate };
      });
    const usage = await this.usage.summary({ from: p.from, to: p.to, partnerCode: partner.code });
    const calls = Object.fromEntries(usage.map((u) => [u.apiSlug, u.billable]));
    // Frais d'arbitrage à la charge de la partie perdante, décision rendue dans le mois.
    const decided = await this.events.find({ where: { action: 'decide', occurredOn: Between(p.from, p.to) } });
    const lost = decided.length
      ? (await this.disputes.find({ where: { id: In(decided.map((e) => e.disputeId)) } }))
          .filter((d) => d.arbitrationFees && ((d.winner === 'ISSUER' && d.acquirerId === partner.id) || (d.winner === 'ACQUIRER' && d.issuerId === partner.id)))
          .map((d) => ({ ref: d.transactionRef, fees: d.arbitrationFees! }))
      : [];
    return computeLines(period, billable, calls, lost);
  }

  /** Émet les relevés du mois ; une banque déjà facturée pour ce mois est ignorée (idempotent). */
  async generate(period: string, actor: string) {
    const today = this.clock.today();
    if (periodBounds(period).to >= today) throw new BusinessRuleError('PERIOD_NOT_CLOSED', 'Le mois doit être terminé avant d’émettre les relevés.');
    const created: Statement[] = [];
    for (const partner of await this.partners.find({ where: { status: In([PartnerStatus.ACTIVE, PartnerStatus.SUSPENDED]) } })) {
      if (await this.statements.findOne({ where: { partnerId: partner.id, period } })) continue;
      const lines = await this.preview(partner, period);
      if (lines.length === 0) continue;
      const st = await this.statements.save(this.statements.create({ partnerId: partner.id, period, lines, total: total(lines), paid: 0, status: 'ISSUED', issuedOn: today, dueDate: dueDateOf(today) }));
      created.push(st);
      await this.notifications.toBank(partner.id, 'Nouveau relevé', `Votre relevé de ${period} est disponible.`, `/compte/consommation`);
    }
    await this.audit.record({ actor, action: 'billing.generate', objectType: 'statement', objectId: period, details: { count: created.length } });
    return created;
  }

  list(filter: { period?: string; partnerId?: string }) {
    return this.statements.find({ where: { ...(filter.period ? { period: filter.period } : {}), ...(filter.partnerId ? { partnerId: filter.partnerId } : {}) }, order: { period: 'DESC' } });
  }

  async get(id: string) {
    const s = await this.statements.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Introuvable');
    return { ...s, payments: await this.payments.find({ where: { statementId: id }, order: { receivedOn: 'ASC' } }), ...settle(s.total, s.paid) };
  }

  /** Paiement reçu : affecté à un relevé de la même banque, ou laissé à rapprocher. */
  async recordPayment(dto: PaymentDto, actor: string) {
    if (dto.statementId) {
      const st = await this.statements.findOne({ where: { id: dto.statementId } });
      if (!st || st.partnerId !== dto.partnerId) throw new BusinessRuleError('STATEMENT_MISMATCH', 'Ce relevé n’appartient pas à cette banque.');
    }
    if (await this.payments.findOne({ where: { partnerId: dto.partnerId, reference: dto.reference } })) {
      throw new BusinessRuleError('PAYMENT_DUPLICATE', 'Ce paiement (même référence) est déjà enregistré.');
    }
    const pay = await this.payments.save(this.payments.create({ ...dto, statementId: dto.statementId ?? null, recordedBy: actor }));
    if (dto.statementId) await this.refresh(dto.statementId);
    await this.audit.record({ actor, action: 'billing.payment', objectType: 'statement', objectId: dto.statementId ?? dto.partnerId, details: { amount: dto.amount, reference: dto.reference } });
    return pay;
  }

  async assign(paymentId: string, statementId: string, actor: string) {
    const pay = await this.payments.findOne({ where: { id: paymentId } });
    const st = await this.statements.findOne({ where: { id: statementId } });
    if (!pay || !st) throw new NotFoundException('Introuvable');
    if (pay.statementId) throw new BusinessRuleError('PAYMENT_ASSIGNED', 'Ce paiement est déjà rapproché.');
    if (pay.partnerId !== st.partnerId) throw new BusinessRuleError('STATEMENT_MISMATCH', 'Ce relevé n’appartient pas à cette banque.');
    pay.statementId = statementId;
    await this.payments.save(pay);
    await this.refresh(statementId);
    await this.audit.record({ actor, action: 'billing.assign', objectType: 'statement', objectId: statementId, details: { paymentId } });
    return this.get(statementId);
  }

  private async refresh(statementId: string) {
    const st = (await this.statements.findOne({ where: { id: statementId } }))!;
    st.paid = (await this.payments.find({ where: { statementId } })).reduce((s, p) => s + p.amount, 0);
    st.status = settle(st.total, st.paid).status;
    await this.statements.save(st);
  }

  /** Rapprochement : par relevé (dû, payé, reste, trop-perçu, en retard) et paiements non affectés. */
  async reconciliation(period?: string) {
    const today = this.clock.today();
    const sts = await this.list({ period });
    const partners = new Map((await this.partners.find()).map((p) => [p.id, p.code]));
    return {
      statements: sts.map((s) => ({ id: s.id, bank: partners.get(s.partnerId) ?? '?', period: s.period, total: s.total, paid: s.paid, dueDate: s.dueDate, ...settle(s.total, s.paid), overdue: s.paid < s.total && s.dueDate < today })),
      unassigned: (await this.payments.find({ where: { statementId: IsNull() } })).map((p) => ({ ...p, bank: partners.get(p.partnerId) ?? '?' })),
    };
  }
}

@Controller('billing')
@UseGuards(ConsoleGuard)
@Section('finance')
export class BillingController {
  constructor(private readonly s: BillingService) {}
  @Post('statements/generate') @HttpCode(200) generate(@Body() dto: GenerateDto, @Actor() actor: string) {
    return this.s.generate(dto.period, actor);
  }
  @Get('statements') list(@Query('period') period?: string, @Query('partnerId') partnerId?: string) {
    return this.s.list({ period, partnerId });
  }
  @Get('statements/:id') get(@Param('id') id: string) {
    return this.s.get(id);
  }
  @Post('payments') pay(@Body() dto: PaymentDto, @Actor() actor: string) {
    return this.s.recordPayment(dto, actor);
  }
  @Post('payments/:id/assign') @HttpCode(200) assign(@Param('id') id: string, @Body() body: { statementId: string }, @Actor() actor: string) {
    return this.s.assign(id, body.statementId, actor);
  }
  @Get('reconciliation') reconciliation(@Query('period') period?: string) {
    return this.s.reconciliation(period);
  }
}

@Controller('portal/statements')
@UseGuards(PortalGuard)
@PortalArea('compte')
export class PortalStatementsController {
  constructor(private readonly s: BillingService) {}
  @Get() list(@Bank() bank: BankContext) {
    return this.s.list({ partnerId: bank.partnerId });
  }
  @Get(':id') async get(@Bank() bank: BankContext, @Param('id') id: string) {
    const st = await this.s.get(id);
    if (st.partnerId !== bank.partnerId) throw new NotFoundException('Introuvable');
    const { payments, ...rest } = st;
    return { ...rest, payments: payments.map(({ amount, reference, receivedOn }) => ({ amount, reference, receivedOn })) };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Statement, Payment, Partner, Subscription, Plan, ApiProduct, Dispute, DisputeEvent]), AuditModule, UsageModule],
  providers: [BillingService],
  controllers: [BillingController, PortalStatementsController],
})
export class BillingModule {}
