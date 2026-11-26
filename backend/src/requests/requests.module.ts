import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Module, NotFoundException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { IsBoolean, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { Holiday, ServiceCommitment, ServiceRequest } from './request.entities';
import {
  DEFAULT_COMMITMENTS,
  RequestStatus,
  RequestType,
  assertAction,
  assertReopenable,
  assertSecondValidator,
  dueDate,
  endSuspension,
  slaLevel,
  isOpen,
  routeOf,
} from './request-rules';
import { enqueue } from '../integration/outbox';
import { TOPICS } from '../integration/message-bus';
import { Inbox } from '../integration/integration.module';
import { NotificationsService, Team } from '../notifications/notifications.module';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { WorkingCalendar } from '../common/working-days';
import { CLOCK, Clock } from '../common/clock';
import { findOr404 } from '../common/crud';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { ConsoleGuard, Section } from '../auth/guards';
import { Actor } from '../common/actor.decorator';
import { Partner } from '../partners/partner.entity';

// ---------- DTO ----------

const FULL_PAN = /\b\d{13,19}\b/;

export class CreateRequestDto {
  @IsUUID() partnerId: string;
  @IsEnum(RequestType) type: RequestType;
  @IsString() @MaxLength(200) subject: string;
  @IsOptional() @IsObject() context?: Record<string, string>;
  @IsOptional() @IsBoolean() sensitive?: boolean;
}

export class AssignDto {
  @IsString() @MaxLength(120) assignee: string;
}

export class WaitDto {
  @IsIn(['BANK', 'THIRD_PARTY']) on: 'BANK' | 'THIRD_PARTY';
}

export class RejectRequestDto {
  @IsString() @MaxLength(300) reason: string;
}

export class HolidayDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @IsString() @MaxLength(120) label: string;
}

export class CommitmentDto {
  @IsString() @MaxLength(30) team: string;
  @IsInt() @Min(1) slaDays: number;
}

// ---------- Service ----------

@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(ServiceRequest) private readonly repo: Repository<ServiceRequest>,
    @InjectRepository(Holiday) private readonly holidays: Repository<Holiday>,
    @InjectRepository(ServiceCommitment) private readonly commitments: Repository<ServiceCommitment>,
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly inbox: Inbox,
    private readonly notifications: NotificationsService,
  ) {}

  private readonly logger = new Logger('Demandes');

  async calendar(): Promise<WorkingCalendar> {
    return new WorkingCalendar((await this.holidays.find()).map((h) => h.date));
  }

  async commitment(type: RequestType): Promise<{ team: string; slaDays: number }> {
    return (await this.commitments.findOne({ where: { type } })) ?? DEFAULT_COMMITMENTS[type];
  }

  async create(dto: CreateRequestDto, actor: string): Promise<ServiceRequest> {
    await findOr404(this.partners, dto.partnerId, 'Partenaire');
    if (dto.context && Object.values(dto.context).some((v) => FULL_PAN.test(String(v)))) {
      throw new BusinessRuleError(
        'FULL_PAN_FORBIDDEN',
        'Le numéro de carte complet est interdit : utilisez le format masqué (6 premiers et 4 derniers chiffres).',
      );
    }
    const partner = await this.partners.findOneByOrFail({ id: dto.partnerId });
    const { team, slaDays } = await this.commitment(dto.type);
    const route = routeOf(dto.type, dto.context);
    // Demande et ordre au Cockpit enregistrés ensemble (outbox). Le Cockpit est un système SMT : le délai court.
    const req = await this.repo.manager.transaction(async (m) => {
      const r = await m.save(
        m.create(ServiceRequest, {
          partnerId: dto.partnerId,
          type: dto.type,
          subject: dto.subject,
          context: dto.context ?? null,
          sensitive: dto.sensitive ?? false,
          team,
          slaDays,
          openedOn: this.clock.today(),
          status: route ? RequestStatus.IN_PROGRESS : RequestStatus.NEW,
          assignee: route ? 'SMT Cockpit' : null,
          routedTo: route,
        }),
      );
      if (route === 'COCKPIT') {
        await enqueue(m, TOPICS.cockpitOrder, { requestId: r.id, partnerCode: partner.code, service: dto.context!.service.toUpperCase(), subject: r.subject, context: r.context ?? {} });
      }
      return r;
    });
    await this.log(actor, 'create', req, { type: req.type, team, slaDays, routedTo: route });
    if (!route) await this.notifications.toTeam(team as Team, `Nouvelle demande ${partner.code}`, `« ${req.subject} » (${dto.type}).`, '/demandes');
    return req;
  }

  /** Retour du Cockpit (webhook vérifié par le connecteur). */
  async onCockpitEvent(p: { requestId: string; status: 'DONE' | 'REJECTED' | 'NEED_INFO' | 'IN_PROGRESS' | 'TRANSMISSION_FAILED'; message?: string }, m = this.repo.manager) {
    const r = await m.findOne(ServiceRequest, { where: { id: p.requestId } });
    if (!r) throw new Error(`Demande ${p.requestId} inconnue`);
    const from = r.status;
    const today = this.clock.today();
    const cal = await this.calendar();
    if (r.routedTo !== 'COCKPIT' || !isOpen(r.status)) {
      this.logger.warn(`Événement Cockpit ignoré pour la demande ${r.id} (état ${r.status})`);
      return;
    }
    r.externalMessage = p.message?.slice(0, 300) ?? null;
    const resume = () => {
      if (r.suspendedSince) r.suspendedWorkingDays = endSuspension(r, cal, today);
      r.suspendedSince = null;
    };
    if (p.status === 'DONE') {
      resume();
      if (r.sensitive) {
        // Opération sensible : exécutée par le Cockpit, validée par un agent (double validation).
        r.preparedBy = 'SMT Cockpit';
        r.status = RequestStatus.AWAITING_VALIDATION;
      } else {
        r.status = RequestStatus.DONE;
        r.doneOn = today;
      }
    } else if (p.status === 'REJECTED') {
      resume();
      r.status = RequestStatus.REJECTED;
      r.rejectionReason = p.message?.slice(0, 300) ?? 'Rejetée par le Cockpit';
      r.doneOn = today;
    } else if (p.status === 'TRANSMISSION_FAILED') {
      // Le Cockpit n'a pas pu recevoir l'ordre : la demande revient aux agents SMT, le délai continue de courir.
      r.routedTo = null;
      r.assignee = null;
      r.status = RequestStatus.IN_PROGRESS;
    } else if (p.status === 'NEED_INFO') {
      r.status = RequestStatus.WAITING_BANK;
      r.suspendedSince = today;
    }
    await m.save(r);
    if (from !== r.status) await this.notifyChange(r);
    await this.audit.record({ actor: 'connecteur-cockpit', action: `request.cockpit.${p.status.toLowerCase()}`, objectType: 'request', objectId: r.id, details: { from, to: r.status } });
  }

  onModuleInit() {
    void this.inbox.consume('backend.cockpit.event', [TOPICS.cockpitEvent], (msg, m) => this.onCockpitEvent(msg.payload as any, m));
  }

  async list(filter: { partnerId?: string; status?: RequestStatus; team?: string }) {
    const where: FindOptionsWhere<ServiceRequest> = {};
    if (filter.partnerId) where.partnerId = filter.partnerId;
    if (filter.status) where.status = filter.status;
    if (filter.team) where.team = filter.team;
    const items = await this.repo.find({ where, order: { openedOn: 'ASC' } });
    const cal = await this.calendar();
    return items.map((r) => this.view(r, cal));
  }

  async get(id: string) {
    return this.view(await findOr404(this.repo, id, 'Demande'), await this.calendar());
  }

  private view(r: ServiceRequest, cal: WorkingCalendar) {
    const today = this.clock.today();
    return { ...r, dueDate: dueDate(r, cal, today), sla: slaLevel(r, cal, today) };
  }

  assign(id: string, assignee: string, actor: string) {
    return this.act(id, 'assign', actor, (r) => {
      r.assignee = assignee;
      r.status = RequestStatus.IN_PROGRESS;
    });
  }

  wait(id: string, on: 'BANK' | 'THIRD_PARTY', actor: string) {
    return this.act(id, 'wait', actor, (r, today) => {
      r.status = on === 'BANK' ? RequestStatus.WAITING_BANK : RequestStatus.WAITING_THIRD_PARTY;
      r.suspendedSince = today;
    });
  }

  resume(id: string, actor: string) {
    return this.act(id, 'resume', actor, (r, today, cal) => {
      r.suspendedWorkingDays = endSuspension(r, cal, today);
      r.suspendedSince = null;
      r.status = RequestStatus.IN_PROGRESS;
    });
  }

  /** Traitement : une demande sensible passe en attente de validation, sinon elle est terminée. */
  complete(id: string, actor: string) {
    return this.act(id, 'complete', actor, (r, today) => {
      if (r.sensitive) {
        r.preparedBy = actor;
        r.status = RequestStatus.AWAITING_VALIDATION;
      } else {
        r.status = RequestStatus.DONE;
        r.doneOn = today;
      }
    });
  }

  validate(id: string, actor: string) {
    return this.act(id, 'validate', actor, (r, today) => {
      assertSecondValidator(r.preparedBy, actor);
      r.validatedBy = actor;
      r.status = RequestStatus.DONE;
      r.doneOn = today;
    });
  }

  close(id: string, actor: string) {
    return this.act(id, 'close', actor, (r) => (r.status = RequestStatus.CLOSED));
  }

  reject(id: string, reason: string, actor: string) {
    return this.act(id, 'reject', actor, (r, today, cal) => {
      if (r.suspendedSince) r.suspendedWorkingDays = endSuspension(r, cal, today);
      r.suspendedSince = null;
      r.rejectionReason = reason;
      r.status = RequestStatus.REJECTED;
      r.doneOn = today;
    });
  }

  reopen(id: string, actor: string) {
    return this.act(id, 'reopen', actor, (r, today, cal) => {
      assertReopenable(r.doneOn, cal, today);
      r.doneOn = null;
      r.preparedBy = null;
      r.validatedBy = null;
      r.status = RequestStatus.IN_PROGRESS;
    });
  }

  async addHoliday(dto: HolidayDto, actor: string) {
    const h = await this.holidays.save(this.holidays.create(dto));
    await this.audit.record({ actor, action: 'holiday.set', objectType: 'holiday', objectId: h.date, details: { ...dto } });
    return h;
  }

  listHolidays() {
    return this.holidays.find({ order: { date: 'ASC' } });
  }

  async setCommitment(type: RequestType, dto: CommitmentDto, actor: string) {
    const c = await this.commitments.save(this.commitments.create({ type, ...dto }));
    await this.audit.record({ actor, action: 'commitment.set', objectType: 'commitment', objectId: type, details: { ...dto } });
    return c;
  }

  async listCommitments() {
    const overrides = await this.commitments.find();
    return Object.values(RequestType).map((type) => overrides.find((o) => o.type === type) ?? { type, ...DEFAULT_COMMITMENTS[type] });
  }

  private async act(
    id: string,
    action: Parameters<typeof assertAction>[1],
    actor: string,
    apply: (r: ServiceRequest, today: string, cal: WorkingCalendar) => void,
  ) {
    const r = await findOr404(this.repo, id, 'Demande');
    assertAction(r.status, action);
    const from = r.status;
    const cal = await this.calendar();
    apply(r, this.clock.today(), cal);
    const saved = await this.repo.save(r);
    await this.log(actor, action, saved, { from, to: saved.status });
    if (from !== saved.status) await this.notifyChange(saved);
    return this.view(saved, cal);
  }

  /** Changement d'état : la banque est prévenue ; une validation attendue est signalée à l'équipe. */
  private async notifyChange(r: ServiceRequest) {
    const msg: Partial<Record<RequestStatus, string>> = {
      [RequestStatus.IN_PROGRESS]: 'est prise en charge par SMT',
      [RequestStatus.WAITING_BANK]: `attend une réponse de votre part${r.externalMessage ? ` : ${r.externalMessage}` : ''}`,
      [RequestStatus.DONE]: 'a été traitée',
      [RequestStatus.REJECTED]: `a été rejetée${r.rejectionReason ? ` : ${r.rejectionReason}` : ''}`,
      [RequestStatus.CLOSED]: 'est clôturée',
    };
    const text = msg[r.status];
    if (text) await this.notifications.toBank(r.partnerId, 'Mise à jour de votre demande', `Votre demande « ${r.subject} » ${text}.`, `/demandes/${r.id}`);
    if (r.status === RequestStatus.AWAITING_VALIDATION) await this.notifications.toTeam(r.team as Team, 'Validation attendue', `La demande « ${r.subject} » attend une seconde validation.`, '/demandes');
  }

  /** Alerte de délai (75 %) et dépassement (100 %) : une seule notification par niveau. */
  async checkSla(): Promise<number> {
    const cal = await this.calendar();
    const today = this.clock.today();
    let sent = 0;
    for (const r of await this.repo.find({ where: { status: In([RequestStatus.NEW, RequestStatus.IN_PROGRESS, RequestStatus.AWAITING_VALIDATION]) } })) {
      const level = slaLevel(r, cal, today);
      if ((level === 'ALERT' || level === 'BREACH') && r.alertLevel !== level) {
        r.alertLevel = level;
        await this.repo.save(r);
        await this.notifications.toTeam(r.team as Team, level === 'ALERT' ? 'Délai bientôt atteint' : 'Délai dépassé', `Demande « ${r.subject} » : échéance le ${dueDate(r, cal, today)}.`, '/demandes');
        sent++;
      }
    }
    return sent;
  }

  onApplicationBootstrap() {
    if (process.env.DISABLE_JOBS !== 'true') this.slaTimer = setInterval(() => void this.checkSla().catch((e) => this.logger.error(e.message)), 15 * 60_000);
  }
  onModuleDestroy() {
    clearInterval(this.slaTimer);
  }
  private slaTimer?: NodeJS.Timeout;

  private log(actor: string, action: string, r: ServiceRequest, details: Record<string, unknown>) {
    return this.audit.record({ actor, action: `request.${action}`, objectType: 'request', objectId: r.id, details });
  }
}

// ---------- Contrôleurs ----------

@Controller('requests')
@Section('demandes')
@UseGuards(ConsoleGuard)
export class RequestsController {
  constructor(private readonly service: RequestsService) {}

  @Get()
  list(@Query('partnerId') partnerId?: string, @Query('status') status?: RequestStatus, @Query('team') team?: string) {
    return this.service.list({ partnerId, status, team });
  }

  @Get(':id') get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post() create(@Body() dto: CreateRequestDto, @Actor() actor: string) {
    return this.service.create(dto, actor);
  }

  @Post(':id/assign') @HttpCode(200) assign(@Param('id') id: string, @Body() dto: AssignDto, @Actor() actor: string) {
    return this.service.assign(id, dto.assignee, actor);
  }

  @Post(':id/wait') @HttpCode(200) wait(@Param('id') id: string, @Body() dto: WaitDto, @Actor() actor: string) {
    return this.service.wait(id, dto.on, actor);
  }

  @Post(':id/resume') @HttpCode(200) resume(@Param('id') id: string, @Actor() actor: string) {
    return this.service.resume(id, actor);
  }

  @Post(':id/complete') @HttpCode(200) complete(@Param('id') id: string, @Actor() actor: string) {
    return this.service.complete(id, actor);
  }

  @Post(':id/validate') @HttpCode(200) validate(@Param('id') id: string, @Actor() actor: string) {
    return this.service.validate(id, actor);
  }

  @Post(':id/close') @HttpCode(200) close(@Param('id') id: string, @Actor() actor: string) {
    return this.service.close(id, actor);
  }

  @Post(':id/reject') @HttpCode(200) reject(@Param('id') id: string, @Body() dto: RejectRequestDto, @Actor() actor: string) {
    return this.service.reject(id, dto.reason, actor);
  }

  @Post(':id/reopen') @HttpCode(200) reopen(@Param('id') id: string, @Actor() actor: string) {
    return this.service.reopen(id, actor);
  }
}

@Controller()
@Section('administration')
@UseGuards(ConsoleGuard)
export class CalendarController {
  constructor(private readonly service: RequestsService) {}

  @Get('holidays') holidays() {
    return this.service.listHolidays();
  }

  @Post('holidays') addHoliday(@Body() dto: HolidayDto, @Actor() actor: string) {
    return this.service.addHoliday(dto, actor);
  }

  @Get('commitments') commitments() {
    return this.service.listCommitments();
  }

  @Put('commitments/:type') setCommitment(@Param('type') type: string, @Body() dto: CommitmentDto, @Actor() actor: string) {
    if (!Object.values(RequestType).includes(type as RequestType)) {
      throw new NotFoundException('Type de demande inconnu');
    }
    return this.service.setCommitment(type as RequestType, dto, actor);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([ServiceRequest, Holiday, ServiceCommitment, Partner]), AuditModule],
  providers: [RequestsService],
  controllers: [RequestsController, CalendarController],
  exports: [RequestsService],
})
export class RequestsModule {}
