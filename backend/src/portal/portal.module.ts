import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { IsBoolean, IsEnum, IsIn, IsNumber, IsObject, IsOptional, IsPositive, IsString, Matches, MaxLength } from 'class-validator';
import { BankContext, OnlyRoles, PortalArea, PortalGuard } from '../auth/guards';
import { BankRole, visiblePortalSections } from '../auth/roles';
import { Partner } from '../partners/partner.entity';
import { ApiProduct, ApiStatus } from '../apis/api-product.entity';
import { Plan } from '../plans/plan.entity';
import { RequestsModule, RequestsService } from '../requests/requests.module';
import { RequestStatus, RequestType } from '../requests/request-rules';
import { DisputesModule, DisputesService } from '../disputes/disputes.module';
import { DisputeAction, MASKED_PAN } from '../disputes/dispute-rules';
import { OnboardingModule, OnboardingService, UpdateCaseDto } from '../onboarding/onboarding.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsageModule } from '../usage/usage.module';
import { UsageService } from '../usage/usage.service';
import { isIsoDate } from '../common/dates';

export { Bank } from './bank.decorator';
import { Bank } from './bank.decorator';

/** Ressource d'une autre banque : 404, pour ne pas révéler son existence. */
function own<T>(item: T, belongs: boolean): T {
  if (!belongs) throw new NotFoundException('Introuvable');
  return item;
}

// ---------- DTO du portail : jamais d'identifiant de banque, il vient du jeton ----------

export class PortalRequestDto {
  @IsEnum(RequestType) type: RequestType;
  @IsString() @MaxLength(200) subject: string;
  @IsOptional() @IsObject() context?: Record<string, string>;
  @IsOptional() @IsBoolean() sensitive?: boolean;
}

export class PortalDisputeDto {
  /** Banque acquéreuse, par son code. La banque connectée est l'émettrice. */
  @Matches(/^[A-Za-z0-9_]{2,40}$/) acquirerCode: string;
  @IsString() @MaxLength(40) transactionRef: string;
  @Matches(MASKED_PAN, { message: 'numéro de carte masqué attendu (6 premiers et 4 derniers chiffres)' }) maskedPan: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) transactionDate: string;
  @IsNumber() @IsPositive() transactionAmount: number;
  @IsString() @MaxLength(10) reasonCode: string;
}

export class PortalDisputeActionDto {
  @IsIn(['info-request', 'info-response', 'chargeback', 'second-presentment', 'second-chargeback', 'arbitration-request', 'accept'])
  action: DisputeAction;
  @IsOptional() @IsNumber() @IsPositive() amount?: number;
  @IsOptional() @IsString() @MaxLength(300) documentRef?: string;
  /** Seulement si la banque est à la fois émettrice et acquéreuse (transaction « on-us »). */
  @IsOptional() @IsIn(['ISSUER', 'ACQUIRER']) party?: 'ISSUER' | 'ACQUIRER';
}

export class PortalOnboardingDto {
  @Matches(/^[0-9a-f-]{36}$/i) apiId: string;
  @Matches(/^[0-9a-f-]{36}$/i) planId: string;
}

// ---------- Contrôleur ----------

@Controller('portal')
@UseGuards(PortalGuard)
export class PortalController {
  constructor(
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    @InjectRepository(ApiProduct) private readonly apis: Repository<ApiProduct>,
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    private readonly requests: RequestsService,
    private readonly disputes: DisputesService,
    private readonly onboardings: OnboardingService,
    private readonly subscriptions: SubscriptionsService,
    private readonly usage: UsageService,
  ) {}

  // --- Profil et menu ---

  @Get('me')
  async me(@Bank() bank: BankContext) {
    const partner = await this.partners.findOneOrFail({ where: { id: bank.partnerId } });
    return {
      username: bank.username,
      partner: { id: partner.id, code: partner.code, name: partner.name, status: partner.status },
      roles: bank.roles.filter((r) => r.startsWith('banque-')),
      sections: visiblePortalSections(bank.roles),
    };
  }

  // --- Développeurs : catalogue, abonnements, mises en service ---

  @Get('catalogue')
  @PortalArea('developpeurs')
  async catalogue() {
    const items = await this.apis.find({ where: { status: In([ApiStatus.PUBLISHED, ApiStatus.BETA]) }, order: { name: 'ASC' } });
    // Jamais le fournisseur ni le chemin amont : la banque ne voit que le service.
    return items.map(({ id, name, slug, version, description, publicPath, status, securityLevel, billingUnit }) => ({
      id, name, slug, version, description, publicPath, status, securityLevel, billingUnit,
    }));
  }

  /** Plans proposés à la souscription (sans réglages internes). */
  @Get('plans')
  @PortalArea('developpeurs')
  async plansList() {
    const items = await this.plans.find({ where: { active: true }, order: { name: 'ASC' } });
    return items.map(({ id, name, dailyQuota, monthlyQuota, rateLimitPerSecond }) => ({ id, name, dailyQuota, monthlyQuota, rateLimitPerSecond }));
  }

  @Get('subscriptions')
  @PortalArea('compte')
  subscriptionsList(@Bank() bank: BankContext) {
    return this.subscriptions.list({ partnerId: bank.partnerId });
  }

  @Get('usage/summary')
  @PortalArea('compte')
  usageSummary(@Bank() bank: BankContext, @Query('from') from: string, @Query('to') to: string) {
    if (!from || !to || !isIsoDate(from) || !isIsoDate(to) || to < from) {
      throw new BadRequestException('Paramètres from et to requis, au format AAAA-MM-JJ, avec from ≤ to');
    }
    return this.usage.summary({ from, to, partnerCode: bank.partnerCode });
  }

  @Get('onboardings')
  @PortalArea('developpeurs')
  onboardingList(@Bank() bank: BankContext) {
    return this.onboardings.list({ partnerId: bank.partnerId });
  }

  @Get('onboardings/:id')
  @PortalArea('developpeurs')
  async onboardingGet(@Bank() bank: BankContext, @Param('id') id: string) {
    const o = await this.onboardings.get(id);
    return own(o, o.partnerId === bank.partnerId);
  }

  @Post('onboardings')
  @PortalArea('developpeurs')
  onboardingCreate(@Bank() bank: BankContext, @Body() dto: PortalOnboardingDto) {
    return this.onboardings.create({ partnerId: bank.partnerId, ...dto }, bank.actor);
  }

  @Patch('onboardings/:id/cases/:caseId')
  @PortalArea('developpeurs')
  async onboardingCase(@Bank() bank: BankContext, @Param('id') id: string, @Param('caseId') caseId: string, @Body() dto: UpdateCaseDto) {
    await this.onboardingGet(bank, id);
    return this.onboardings.updateCase(id, caseId, dto, bank.actor);
  }

  /** Signature du PV côté banque : administrateur sécurité uniquement. */
  @Post('onboardings/:id/sign')
  @HttpCode(200)
  @OnlyRoles(BankRole.ADMIN_SECURITE)
  async onboardingSign(@Bank() bank: BankContext, @Param('id') id: string) {
    await this.onboardingGet(bank, id);
    return this.onboardings.sign(id, 'BANK', bank.actor);
  }

  // --- Demandes ---

  @Get('requests')
  @PortalArea('demandes')
  requestList(@Bank() bank: BankContext, @Query('status') status?: RequestStatus) {
    return this.requests.list({ partnerId: bank.partnerId, status });
  }

  @Get('requests/:id')
  @PortalArea('demandes')
  async requestGet(@Bank() bank: BankContext, @Param('id') id: string) {
    const r = await this.requests.get(id);
    return own(r, r.partnerId === bank.partnerId);
  }

  @Post('requests')
  @PortalArea('demandes')
  requestCreate(@Bank() bank: BankContext, @Body() dto: PortalRequestDto) {
    return this.requests.create({ ...dto, partnerId: bank.partnerId }, bank.actor);
  }

  /** La banque a répondu : le délai repart. */
  @Post('requests/:id/reply')
  @HttpCode(200)
  @PortalArea('demandes')
  async requestReply(@Bank() bank: BankContext, @Param('id') id: string) {
    const r = await this.requestGet(bank, id);
    if (r.status !== RequestStatus.WAITING_BANK) {
      throw new BadRequestException('Cette demande n’attend pas de réponse de votre part.');
    }
    return this.requests.resume(id, bank.actor);
  }

  @Post('requests/:id/reopen')
  @HttpCode(200)
  @PortalArea('demandes')
  async requestReopen(@Bank() bank: BankContext, @Param('id') id: string) {
    await this.requestGet(bank, id);
    return this.requests.reopen(id, bank.actor);
  }

  // --- Litiges ---

  @Get('disputes')
  @PortalArea('litiges')
  disputeList(@Bank() bank: BankContext) {
    return this.disputes.list({ bankId: bank.partnerId });
  }

  @Get('disputes/:id')
  @PortalArea('litiges')
  async disputeGet(@Bank() bank: BankContext, @Param('id') id: string) {
    const d = await this.disputes.get(id);
    return own(d, d.issuerId === bank.partnerId || d.acquirerId === bank.partnerId);
  }

  @Post('disputes')
  @PortalArea('litiges')
  async disputeOpen(@Bank() bank: BankContext, @Body() dto: PortalDisputeDto) {
    const acquirer = await this.partners.findOne({ where: { code: dto.acquirerCode.toUpperCase() } });
    if (!acquirer) throw new NotFoundException('Banque acquéreuse inconnue');
    const { acquirerCode: _ignored, ...rest } = dto;
    return this.disputes.open({ ...rest, issuerId: bank.partnerId, acquirerId: acquirer.id }, bank.actor);
  }

  /** Le rôle (émetteur ou acquéreur) est déduit de la banque connectée. */
  @Post('disputes/:id/actions')
  @HttpCode(200)
  @PortalArea('litiges')
  async disputeAct(@Bank() bank: BankContext, @Param('id') id: string, @Body() dto: PortalDisputeActionDto) {
    const d = await this.disputeGet(bank, id);
    const issuer = d.issuerId === bank.partnerId;
    const acquirer = d.acquirerId === bank.partnerId;
    let party: 'ISSUER' | 'ACQUIRER';
    if (issuer && acquirer) {
      if (!dto.party) throw new BadRequestException('Transaction « on-us » : précisez party (ISSUER ou ACQUIRER).');
      party = dto.party;
    } else {
      party = issuer ? 'ISSUER' : 'ACQUIRER';
    }
    const { party: _p, ...action } = dto;
    return this.disputes.act(id, { ...action, party }, bank.actor);
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([Partner, ApiProduct, Plan]),
    RequestsModule,
    DisputesModule,
    OnboardingModule,
    SubscriptionsModule,
    UsageModule,
  ],
  controllers: [PortalController],
})
export class PortalModule {}
