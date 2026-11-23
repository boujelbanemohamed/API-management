import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, NotFoundException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
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
} from './request-rules';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { WorkingCalendar } from '../common/working-days';
import { CLOCK, Clock } from '../common/clock';
import { findOr404 } from '../common/crud';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { AdminTokenGuard } from '../common/admin-token.guard';
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
  ) {}

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
    const { team, slaDays } = await this.commitment(dto.type);
    const req = await this.repo.save(
      this.repo.create({
        partnerId: dto.partnerId,
        type: dto.type,
        subject: dto.subject,
        context: dto.context ?? null,
        sensitive: dto.sensitive ?? false,
        team,
        slaDays,
        openedOn: this.clock.today(),
        status: RequestStatus.NEW,
      }),
    );
    await this.log(actor, 'create', req, { type: req.type, team, slaDays });
    return req;
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
    return this.view(saved, cal);
  }

  private log(actor: string, action: string, r: ServiceRequest, details: Record<string, unknown>) {
    return this.audit.record({ actor, action: `request.${action}`, objectType: 'request', objectId: r.id, details });
  }
}

// ---------- Contrôleurs ----------

@Controller('requests')
@UseGuards(AdminTokenGuard)
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
@UseGuards(AdminTokenGuard)
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
