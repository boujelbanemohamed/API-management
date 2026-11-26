import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Column, CreateDateColumn, Entity, FindOptionsWhere, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import {
  ActionInput,
  DisputeAction,
  DisputeStage,
  MASKED_PAN,
  Party,
  applyAction,
  expiredLoser,
  initialDeadline,
} from './dispute-rules';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { enqueue } from '../integration/outbox';
import { TOPICS } from '../integration/message-bus';
import { Inbox } from '../integration/integration.module';
import { CLOCK, Clock } from '../common/clock';
import { findOr404 } from '../common/crud';
import { Partner } from '../partners/partner.entity';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { ConsoleGuard, OnlyRoles, Section } from '../auth/guards';
import { ConsoleRole } from '../auth/roles';
import { Actor } from '../common/actor.decorator';

// ---------- Entités ----------

@Entity('disputes')
@Index(['issuerId', 'stage'])
@Index(['acquirerId', 'stage'])
export class Dispute {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** Banque émettrice (porteur). */
  @Column({ type: 'varchar', length: 36 }) issuerId: string;
  /** Banque acquéreuse (commerçant). */
  @Column({ type: 'varchar', length: 36 }) acquirerId: string;
  @Column({ type: 'varchar', length: 40 }) transactionRef: string;
  /** Jamais de numéro complet : 6 premiers et 4 derniers chiffres. */
  @Column({ type: 'varchar', length: 19 }) maskedPan: string;
  @Column({ type: 'varchar', length: 10 }) transactionDate: string;
  /** Montant en millimes. */
  @Column({ type: 'int' }) transactionAmount: number;
  @Column({ type: 'varchar', length: 3, default: '788' }) currency: string;
  @Column({ type: 'varchar', length: 10 }) reasonCode: string;
  @Column({ type: 'varchar', length: 30, default: DisputeStage.OPENED }) stage: DisputeStage;
  @Column({ type: 'varchar', length: 10, nullable: true }) deadline: string | null;
  @Column({ type: 'int', nullable: true }) disputedAmount: number | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) winner: 'ISSUER' | 'ACQUIRER' | null;
  @Column({ type: 'int', nullable: true }) arbitrationFees: number | null;
  @CreateDateColumn() createdAt: Date;
}

@Entity('dispute_events')
@Index(['disputeId'])
export class DisputeEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36 }) disputeId: string;
  @Column({ type: 'varchar', length: 30 }) action: string;
  @Column({ type: 'varchar', length: 10 }) party: string;
  @Column({ type: 'varchar', length: 120 }) actor: string;
  @Column({ type: 'varchar', length: 10 }) occurredOn: string;
  @Column({ type: 'varchar', length: 30 }) toStage: string;
  @Column({ type: 'varchar', length: 4, nullable: true }) mti: string | null;
  @Column({ type: 'varchar', length: 3, nullable: true }) functionCode: string | null;
  @Column({ type: 'int', nullable: true }) amount: number | null;
  /** Référence de la pièce stockée (analysée par l'antivirus). */
  @Column({ type: 'varchar', length: 300, nullable: true }) documentRef: string | null;
  /** Acheminement du message ISO vers la plateforme Chargeback : PENDING, ACKED, REJECTED ou FAILED. */
  @Column({ type: 'varchar', length: 10, nullable: true }) deliveryStatus: 'PENDING' | 'ACKED' | 'REJECTED' | 'FAILED' | null;
  /** Code action ISO (champ 39) renvoyé par la plateforme. */
  @Column({ type: 'varchar', length: 3, nullable: true }) actionCode: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) deliveryDetail: string | null;
}

// ---------- DTO ----------

export class OpenDisputeDto {
  @IsUUID() issuerId: string;
  @IsUUID() acquirerId: string;
  @IsString() @MaxLength(40) transactionRef: string;
  @Matches(MASKED_PAN, { message: 'numéro de carte masqué attendu (6 premiers et 4 derniers chiffres)' }) maskedPan: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) transactionDate: string;
  @IsNumber() @IsPositive() transactionAmount: number;
  @IsString() @MaxLength(10) reasonCode: string;
}

export class DisputeActionDto {
  @IsIn(['info-request', 'info-response', 'chargeback', 'second-presentment', 'second-chargeback', 'arbitration-request', 'accept'])
  action: DisputeAction;
  @IsIn(['ISSUER', 'ACQUIRER']) party: 'ISSUER' | 'ACQUIRER';
  @IsOptional() @IsNumber() @IsPositive() amount?: number;
  @IsOptional() @IsString() @MaxLength(300) documentRef?: string;
}

export class DecideDto {
  @IsIn(['ISSUER', 'ACQUIRER']) winner: 'ISSUER' | 'ACQUIRER';
  @IsOptional() @IsNumber() @Min(0) fees?: number;
}

// ---------- Service ----------

@Injectable()
export class DisputesService {
  constructor(
    @InjectRepository(Dispute) private readonly repo: Repository<Dispute>,
    @InjectRepository(DisputeEvent) private readonly events: Repository<DisputeEvent>,
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly inbox: Inbox,
  ) {}

  async open(dto: OpenDisputeDto, actor: string) {
    await findOr404(this.partners, dto.issuerId, 'Banque émettrice');
    await findOr404(this.partners, dto.acquirerId, 'Banque acquéreuse');
    const deadline = initialDeadline(dto.transactionDate);
    if (this.clock.today() > deadline) {
      throw new BusinessRuleError('DEADLINE_PASSED', `Transaction trop ancienne : litige possible jusqu'au ${deadline}.`);
    }
    const d = await this.repo.save(this.repo.create({ ...dto, stage: DisputeStage.OPENED, deadline }));
    await this.audit.record({ actor, action: 'dispute.open', objectType: 'dispute', objectId: d.id, details: { ref: d.transactionRef } });
    return d;
  }

  list(filter: { bankId?: string; stage?: DisputeStage }) {
    const base: FindOptionsWhere<Dispute> = filter.stage ? { stage: filter.stage } : {};
    const where = filter.bankId ? [{ ...base, issuerId: filter.bankId }, { ...base, acquirerId: filter.bankId }] : base;
    return this.repo.find({ where, order: { deadline: 'ASC' } });
  }

  async get(id: string) {
    const d = await findOr404(this.repo, id, 'Litige');
    return { ...d, events: await this.events.find({ where: { disputeId: id } }) };
  }

  act(id: string, dto: DisputeActionDto, actor: string) {
    return this.apply(id, dto.action, { party: dto.party, amount: dto.amount, newDocument: !!dto.documentRef }, actor, dto.documentRef);
  }

  decide(id: string, dto: DecideDto, actor: string) {
    return this.apply(id, 'decide', { party: 'SMT', winner: dto.winner, fees: dto.fees }, actor);
  }

  /** Clôture les litiges dont l'échéance est passée sans réponse (tâche quotidienne). */
  async closeExpired(): Promise<number> {
    const today = this.clock.today();
    let closed = 0;
    for (const d of await this.repo.find()) {
      const loser = expiredLoser(d, today);
      if (!loser) continue;
      d.winner = loser === 'ISSUER' ? 'ACQUIRER' : 'ISSUER';
      d.stage = DisputeStage.CLOSED_EXPIRED;
      await this.repo.save(d);
      await this.record(d, 'expire', 'SMT', 'système', null, null);
      closed++;
    }
    return closed;
  }

  /** Litige, événement et message ISO à envoyer : enregistrés ensemble ou pas du tout (outbox). */
  private async apply(id: string, action: DisputeAction, input: ActionInput, actor: string, documentRef?: string) {
    const d = await findOr404(this.repo, id, 'Litige');
    const res = applyAction(d, action, input, this.clock.today());
    d.stage = res.stage;
    d.deadline = res.deadline;
    if (input.amount !== undefined) d.disputedAmount = input.amount;
    if (action === 'decide') {
      d.winner = input.winner ?? null;
      d.arbitrationFees = input.fees ?? null;
    }
    const [issuer, acquirer] = await Promise.all([
      this.partners.findOneByOrFail({ id: d.issuerId }),
      this.partners.findOneByOrFail({ id: d.acquirerId }),
    ]);
    const saved = await this.repo.manager.transaction(async (m) => {
      const s = await m.save(d);
      const ev = await m.save(
        m.create(DisputeEvent, {
          disputeId: s.id, action, party: input.party, actor, occurredOn: this.clock.today(), toStage: s.stage,
          mti: res.message?.mti ?? null, functionCode: res.message?.functionCode ?? null,
          amount: input.amount ?? (action === 'decide' ? (input.fees ?? null) : null), documentRef: documentRef ?? null,
          deliveryStatus: res.message ? 'PENDING' : null, actionCode: null, deliveryDetail: null,
        }),
      );
      if (res.message) {
        await enqueue(m, TOPICS.chargebackOutgoing, {
          eventId: ev.id, disputeId: s.id, mti: res.message.mti, functionCode: res.message.functionCode,
          amount: action === 'decide' ? (input.fees ?? 0) : (input.amount ?? s.disputedAmount ?? s.transactionAmount),
          currency: s.currency, maskedPan: s.maskedPan, transactionRef: s.transactionRef, transactionDate: s.transactionDate,
          reasonCode: s.reasonCode, issuerCode: issuer.code, acquirerCode: acquirer.code,
        });
      }
      return s;
    });
    await this.audit.record({ actor, action: `dispute.${action}`, objectType: 'dispute', objectId: d.id, details: { party: input.party, stage: d.stage } });
    return { ...saved, message: res.message };
  }

  /** Retour de la plateforme Chargeback (via le connecteur) : met à jour l'acheminement de l'événement. */
  async onChargebackResult(p: { eventId: string; status: 'ACKED' | 'REJECTED' | 'FAILED'; actionCode?: string; detail?: string }, m = this.repo.manager) {
    const ev = await m.findOne(DisputeEvent, { where: { id: p.eventId } });
    if (!ev) throw new Error(`Événement ${p.eventId} inconnu`);
    ev.deliveryStatus = p.status;
    ev.actionCode = p.actionCode ?? null;
    ev.deliveryDetail = p.detail?.slice(0, 300) ?? null;
    await m.save(ev);
    await this.audit.record({ actor: 'connecteur-chargeback', action: `dispute.message.${p.status.toLowerCase()}`, objectType: 'dispute', objectId: ev.disputeId, details: { eventId: ev.id, mti: ev.mti, actionCode: ev.actionCode } });
  }

  onModuleInit() {
    void this.inbox.consume('backend.chargeback.result', [TOPICS.chargebackResult], (msg, m) => this.onChargebackResult(msg.payload as any, m));
  }

  private async record(
    d: Dispute,
    action: string,
    party: Party,
    actor: string,
    message: { mti: string; functionCode: string } | null,
    amount: number | null,
    documentRef?: string,
  ) {
    await this.events.save(
      this.events.create({
        disputeId: d.id,
        action,
        party,
        actor,
        occurredOn: this.clock.today(),
        toStage: d.stage,
        mti: message?.mti ?? null,
        functionCode: message?.functionCode ?? null,
        amount,
        documentRef: documentRef ?? null,
      }),
    );
    await this.audit.record({ actor, action: `dispute.${action}`, objectType: 'dispute', objectId: d.id, details: { party, stage: d.stage } });
  }
}

// ---------- Contrôleur ----------

@Controller('disputes')
@Section('litiges')
@UseGuards(ConsoleGuard)
export class DisputesController {
  constructor(private readonly service: DisputesService) {}

  @Get() list(@Query('bankId') bankId?: string, @Query('stage') stage?: DisputeStage) {
    return this.service.list({ bankId, stage });
  }

  @Get(':id') get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post() open(@Body() dto: OpenDisputeDto, @Actor() actor: string) {
    return this.service.open(dto, actor);
  }

  @Post(':id/actions') @HttpCode(200) act(@Param('id') id: string, @Body() dto: DisputeActionDto, @Actor() actor: string) {
    return this.service.act(id, dto, actor);
  }

  @Post(':id/decision') @HttpCode(200) @OnlyRoles(ConsoleRole.ARBITRE, ConsoleRole.ADMIN) decide(@Param('id') id: string, @Body() dto: DecideDto, @Actor() actor: string) {
    return this.service.decide(id, dto, actor);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Dispute, DisputeEvent, Partner]), AuditModule],
  providers: [DisputesService],
  controllers: [DisputesController],
  exports: [DisputesService],
})
export class DisputesModule {}
