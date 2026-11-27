import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Onboarding, OnboardingTestCase, TestBook } from './onboarding.entities';
import { OnboardingStep, TestCaseStatus, TestMode, assertCanAdvance, assertCanSign } from './onboarding-rules';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { Environment, SubscriptionStatus } from '../subscriptions/subscription.entity';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { findOr404 } from '../common/crud';
import { NotificationsService } from '../notifications/notifications.module';

const STEP_LABEL: Record<OnboardingStep, string> = { REQUEST: 'demande', CONTRACT: 'contrat', SANDBOX: 'sandbox', TESTS: 'tests', ACCEPTANCE: 'recette', PRODUCTION: 'production' };
import { ConsoleGuard, Section } from '../auth/guards';
import { Actor } from '../common/actor.decorator';

// ---------- DTO ----------

export class CreateOnboardingDto {
  @IsUUID() partnerId: string;
  @IsUUID() apiId: string;
  @IsUUID() planId: string;
}

export class ContractDto {
  @IsString() @MaxLength(120) contractReference: string;
  /** Juriste qui valide le contrat. */
  @IsString() @MaxLength(120) validatedBy: string;
}

export class TestModeDto {
  @IsEnum(TestMode) testMode: TestMode;
}

export class AddCaseDto {
  @IsString() @MaxLength(30) code: string;
  @IsString() @MaxLength(200) title: string;
  @IsOptional() @IsBoolean() mandatory?: boolean;
}

export class UpdateCaseDto {
  @IsEnum(TestCaseStatus) status: TestCaseStatus;
  @IsOptional() @IsString() @MaxLength(300) evidence?: string;
}

export class SignDto {
  @IsIn(['BANK', 'SMT']) party: 'BANK' | 'SMT';
}

// ---------- Service ----------

@Injectable()
export class OnboardingService {
  constructor(
    @InjectRepository(Onboarding) private readonly repo: Repository<Onboarding>,
    @InjectRepository(OnboardingTestCase) private readonly cases: Repository<OnboardingTestCase>,
    @InjectRepository(TestBook) private readonly books: Repository<TestBook>,
    private readonly subscriptions: SubscriptionsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: CreateOnboardingDto, actor: string) {
    const open = await this.repo.findOne({ where: { partnerId: dto.partnerId, apiId: dto.apiId, cancelled: false } });
    if (open && open.step !== OnboardingStep.PRODUCTION) {
      throw new BusinessRuleError('ONBOARDING_IN_PROGRESS', 'Une mise en service est déjà en cours pour ce service.');
    }
    const o = await this.repo.save(this.repo.create({ ...dto, step: OnboardingStep.REQUEST }));
    await this.log(actor, 'create', o, { ...dto });
    return o;
  }

  list(filter: { partnerId?: string; step?: OnboardingStep }) {
    const where: FindOptionsWhere<Onboarding> = {};
    if (filter.partnerId) where.partnerId = filter.partnerId;
    if (filter.step) where.step = filter.step;
    return this.repo.find({ where, order: { createdAt: 'ASC' } });
  }

  async get(id: string) {
    const o = await findOr404(this.repo, id, 'Mise en service');
    return { ...o, testCases: await this.cases.find({ where: { onboardingId: id } }) };
  }

  async attachContract(id: string, dto: ContractDto, actor: string) {
    const o = await this.load(id, OnboardingStep.CONTRACT);
    o.contractReference = dto.contractReference;
    o.contractValidatedBy = dto.validatedBy;
    return this.save(o, actor, 'contract', { ...dto });
  }

  async setTestMode(id: string, dto: TestModeDto, actor: string) {
    const o = await this.load(id, OnboardingStep.SANDBOX, OnboardingStep.TESTS);
    o.testMode = dto.testMode;
    return this.save(o, actor, 'test-mode', { ...dto });
  }

  async recordJointSession(id: string, actor: string) {
    const o = await this.load(id, OnboardingStep.TESTS);
    if (o.testMode === TestMode.AUTONOMOUS) {
      throw new BusinessRuleError('AUTONOMOUS_MODE', 'Mode autonomie : pas de session conjointe prévue.');
    }
    o.jointSessions += 1;
    return this.save(o, actor, 'joint-session', { count: o.jointSessions });
  }

  async addCase(id: string, dto: AddCaseDto, actor: string) {
    const o = await this.load(id, OnboardingStep.SANDBOX, OnboardingStep.TESTS);
    const c = await this.cases.save(this.cases.create({ onboardingId: o.id, mandatory: true, ...dto }));
    await this.log(actor, 'case.add', o, { code: c.code });
    return c;
  }

  async updateCase(id: string, caseId: string, dto: UpdateCaseDto, actor: string) {
    const o = await this.load(id, OnboardingStep.TESTS);
    const c = await findOr404(this.cases, caseId, 'Cas de test');
    if (c.onboardingId !== o.id) throw new BusinessRuleError('CASE_MISMATCH', 'Ce cas n’appartient pas à cette mise en service.');
    c.status = dto.status;
    if (dto.evidence !== undefined) c.evidence = dto.evidence;
    await this.cases.save(c);
    await this.log(actor, 'case.update', o, { code: c.code, status: c.status });
    return c;
  }

  async sign(id: string, party: 'BANK' | 'SMT', actor: string) {
    const o = await findOr404(this.repo, id, 'Mise en service');
    assertCanSign(o, party);
    if (party === 'BANK') o.bankSignedBy = actor;
    else o.smtSignedBy = actor;
    if (party === 'BANK') await this.notifications.toTeam('INTEGRATION', 'PV signé par la banque', `Le PV de recette a été signé par ${actor} ; signature SMT attendue.`, `/mises-en-service/${o.id}`);
    else await this.notifications.toBank(o.partnerId, 'PV signé par SMT', 'SMT a signé le PV de recette.', `/mises-en-service/${o.id}`);
    return this.save(o, actor, 'sign', { party });
  }

  /** Avance d'une étape ; à l'entrée en sandbox et en production, l'abonnement est créé automatiquement. */
  async advance(id: string, actor: string) {
    const o = await findOr404(this.repo, id, 'Mise en service');
    const target = assertCanAdvance(o, await this.cases.find({ where: { onboardingId: id } }));
    if (target === OnboardingStep.SANDBOX) {
      await this.openSubscription(o, Environment.SANDBOX, actor);
      // Cahier de tests type du service recopié s'il n'y a pas encore de cas.
      const book = await this.books.findOne({ where: { apiId: o.apiId } });
      if (book && (await this.cases.count({ where: { onboardingId: o.id } })) === 0) {
        await this.cases.save(book.cases.map((c) => this.cases.create({ onboardingId: o.id, ...c })));
      }
    }
    if (target === OnboardingStep.PRODUCTION) {
      o.productionSubscriptionId = await this.openSubscription(o, Environment.PRODUCTION, actor);
    }
    const from = o.step;
    o.step = target;
    const saved = await this.save(o, actor, 'advance', { from, to: target });
    await this.notifications.toBank(o.partnerId, 'Mise en service', `Votre mise en service passe à l’étape : ${STEP_LABEL[target]}.`, `/mises-en-service/${o.id}`);
    return saved;
  }

  getBook(apiId: string) {
    return this.books.findOne({ where: { apiId } }).then((b) => b ?? { apiId, cases: [], version: 0 });
  }

  listBooks() {
    return this.books.find();
  }

  async setBook(apiId: string, cases: { code: string; title: string; mandatory: boolean }[], actor: string) {
    const codes = cases.map((c) => c.code);
    if (new Set(codes).size !== codes.length) throw new BusinessRuleError('DUPLICATE_CASE', 'Deux cas ont le même code.');
    const prev = await this.books.findOne({ where: { apiId } });
    const book = await this.books.save(this.books.create({ apiId, cases, version: (prev?.version ?? 0) + 1, updatedBy: actor }));
    await this.audit.record({ actor, action: 'testbook.update', objectType: 'api', objectId: apiId, details: { cases: cases.length, version: book.version } });
    return book;
  }

  async cancel(id: string, actor: string) {
    const o = await findOr404(this.repo, id, 'Mise en service');
    if (o.step === OnboardingStep.PRODUCTION) {
      throw new BusinessRuleError('ONBOARDING_DONE', 'Service en production : résiliez l’abonnement à la place.');
    }
    o.cancelled = true;
    return this.save(o, actor, 'cancel', {});
  }

  private async openSubscription(o: Onboarding, environment: Environment, actor: string): Promise<string> {
    let sub = await this.subscriptions.create(
      { partnerId: o.partnerId, apiId: o.apiId, planId: o.planId, environment, contractReference: o.contractReference ?? undefined } as any,
      actor,
    );
    if (sub.status === SubscriptionStatus.PENDING) sub = await this.subscriptions.validate(sub.id, actor);
    return sub.id;
  }

  private async load(id: string, ...steps: OnboardingStep[]) {
    const o = await findOr404(this.repo, id, 'Mise en service');
    if (o.cancelled) throw new BusinessRuleError('ONBOARDING_CANCELLED', 'Cette mise en service est annulée.');
    if (!steps.includes(o.step)) {
      throw new BusinessRuleError('WRONG_STEP', `Action impossible à l’étape ${o.step}.`);
    }
    return o;
  }

  private async save(o: Onboarding, actor: string, action: string, details: Record<string, unknown>) {
    const saved = await this.repo.save(o);
    await this.log(actor, action, saved, details);
    return saved;
  }

  private log(actor: string, action: string, o: Onboarding, details: Record<string, unknown>) {
    return this.audit.record({ actor, action: `onboarding.${action}`, objectType: 'onboarding', objectId: o.id, details });
  }
}

// ---------- Contrôleur ----------

@Controller('onboardings')
@Section('mises-en-service')
@UseGuards(ConsoleGuard)
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  @Get() list(@Query('partnerId') partnerId?: string, @Query('step') step?: OnboardingStep) {
    return this.service.list({ partnerId, step });
  }

  @Get(':id') get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post() create(@Body() dto: CreateOnboardingDto, @Actor() actor: string) {
    return this.service.create(dto, actor);
  }

  @Post(':id/contract') @HttpCode(200) contract(@Param('id') id: string, @Body() dto: ContractDto, @Actor() actor: string) {
    return this.service.attachContract(id, dto, actor);
  }

  @Post(':id/test-mode') @HttpCode(200) testMode(@Param('id') id: string, @Body() dto: TestModeDto, @Actor() actor: string) {
    return this.service.setTestMode(id, dto, actor);
  }

  @Post(':id/joint-sessions') @HttpCode(200) joint(@Param('id') id: string, @Actor() actor: string) {
    return this.service.recordJointSession(id, actor);
  }

  @Post(':id/cases') addCase(@Param('id') id: string, @Body() dto: AddCaseDto, @Actor() actor: string) {
    return this.service.addCase(id, dto, actor);
  }

  @Patch(':id/cases/:caseId') updateCase(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @Body() dto: UpdateCaseDto,
    @Actor() actor: string,
  ) {
    return this.service.updateCase(id, caseId, dto, actor);
  }

  @Post(':id/sign') @HttpCode(200) sign(@Param('id') id: string, @Body() dto: SignDto, @Actor() actor: string) {
    return this.service.sign(id, dto.party, actor);
  }

  @Post(':id/advance') @HttpCode(200) advance(@Param('id') id: string, @Actor() actor: string) {
    return this.service.advance(id, actor);
  }

  @Post(':id/cancel') @HttpCode(200) cancel(@Param('id') id: string, @Actor() actor: string) {
    return this.service.cancel(id, actor);
  }
}

export class BookCaseDto {
  @IsString() @MaxLength(30) code: string;
  @IsString() @MaxLength(200) title: string;
  @IsBoolean() mandatory: boolean;
}
export class BookDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => BookCaseDto) cases: BookCaseDto[];
}

@Controller('test-books')
@UseGuards(ConsoleGuard)
@Section('catalogue')
export class TestBooksController {
  constructor(private readonly service: OnboardingService) {}
  @Get() list() {
    return this.service.listBooks();
  }
  @Get(':apiId') get(@Param('apiId') apiId: string) {
    return this.service.getBook(apiId);
  }
  @Put(':apiId') set(@Param('apiId') apiId: string, @Body() dto: BookDto, @Actor() actor: string) {
    return this.service.setBook(apiId, dto.cases, actor);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Onboarding, OnboardingTestCase, TestBook]), SubscriptionsModule, AuditModule],
  providers: [OnboardingService],
  controllers: [OnboardingController, TestBooksController],
  exports: [OnboardingService],
})
export class OnboardingModule {}
