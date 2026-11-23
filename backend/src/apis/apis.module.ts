import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { ApiProduct, ApiStatus, BillingUnit, SecurityLevel } from './api-product.entity';
import { Provider } from '../providers/provider.entity';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { GatewayModule } from '../gateway/gateway.module';
import { GatewaySyncService } from '../gateway/gateway-sync.service';
import { ConsoleGuard, Section } from '../auth/guards';
import { Actor } from '../common/actor.decorator';
import { diff, findOr404 } from '../common/crud';
import { BusinessRuleError } from '../subscriptions/subscription-rules';

const PATH = /^\/[A-Za-z0-9._~\-\/]*$/;

export class CreateApiDto {
  @IsString()
  @Length(2, 120)
  name: string;

  /** Identifiant technique, ex. transactions-v1 */
  @Matches(/^[a-z0-9][a-z0-9-]{1,59}$/, { message: 'slug : minuscules, chiffres et tirets (2 à 60 caractères)' })
  slug: string;

  @IsOptional()
  @Matches(/^v\d+(\.\d+)?$/, { message: 'version au format v1, v2, v1.1…' })
  version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @Matches(PATH, { message: 'publicPath doit commencer par / (ex. /transactions/v1)' })
  publicPath: string;

  @Matches(PATH, { message: 'upstreamPath doit commencer par / (ex. /api/transactions)' })
  upstreamPath: string;

  @IsUUID()
  providerId: string;

  @IsOptional()
  @IsEnum(SecurityLevel)
  securityLevel?: SecurityLevel;

  @IsOptional()
  @IsEnum(BillingUnit)
  billingUnit?: BillingUnit;

  @IsOptional()
  @IsBoolean()
  billFailedCalls?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  maskedFields?: string[];
}

export class UpdateApiDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @Matches(PATH)
  upstreamPath?: string;

  @IsOptional()
  @IsEnum(SecurityLevel)
  securityLevel?: SecurityLevel;

  @IsOptional()
  @IsEnum(BillingUnit)
  billingUnit?: BillingUnit;

  @IsOptional()
  @IsBoolean()
  billFailedCalls?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  maskedFields?: string[];
}

export class ChangeApiStatusDto {
  @IsEnum(ApiStatus)
  status: ApiStatus;
}

/** Cycle de vie d'une API : on avance, on ne revient pas en arrière (sauf BETA -> DRAFT). */
const API_TRANSITIONS: Record<ApiStatus, ApiStatus[]> = {
  DRAFT: [ApiStatus.BETA, ApiStatus.PUBLISHED],
  BETA: [ApiStatus.DRAFT, ApiStatus.PUBLISHED],
  PUBLISHED: [ApiStatus.DEPRECATED],
  DEPRECATED: [ApiStatus.RETIRED, ApiStatus.PUBLISHED],
  RETIRED: [],
};

@Injectable()
export class ApisService {
  constructor(
    @InjectRepository(ApiProduct) private readonly repo: Repository<ApiProduct>,
    @InjectRepository(Provider) private readonly providers: Repository<Provider>,
    private readonly audit: AuditService,
    private readonly sync: GatewaySyncService,
  ) {}

  list(filter: { status?: ApiStatus; providerId?: string }) {
    const where: FindOptionsWhere<ApiProduct> = {};
    if (filter.status) where.status = filter.status;
    if (filter.providerId) where.providerId = filter.providerId;
    return this.repo.find({ where, order: { name: 'ASC' } });
  }

  get(id: string) {
    return findOr404(this.repo, id, 'Service');
  }

  async create(dto: CreateApiDto, actor: string) {
    await findOr404(this.providers, dto.providerId, 'Fournisseur');
    if (await this.repo.findOne({ where: { slug: dto.slug } })) {
      throw new BusinessRuleError('DUPLICATE_SLUG', `L'identifiant ${dto.slug} est déjà utilisé.`);
    }
    if (await this.repo.findOne({ where: { publicPath: dto.publicPath } })) {
      throw new BusinessRuleError('DUPLICATE_PATH', `Le chemin public ${dto.publicPath} est déjà utilisé.`);
    }
    const api = await this.repo.save(this.repo.create({ ...dto, status: ApiStatus.DRAFT }));
    await this.audit.record({ actor, action: 'api.created', objectType: 'api', objectId: api.id, details: { slug: api.slug } });
    return api;
  }

  async update(id: string, dto: UpdateApiDto, actor: string) {
    const api = await this.get(id);
    const changes = diff(api, dto);
    Object.assign(api, dto);
    const saved = await this.repo.save(api);
    if (Object.keys(changes).length) {
      await this.audit.record({ actor, action: 'api.updated', objectType: 'api', objectId: id, details: changes });
      await this.sync.trySync(`service ${api.slug} modifié`);
    }
    return saved;
  }

  async changeStatus(id: string, status: ApiStatus, actor: string) {
    const api = await this.get(id);
    if (!API_TRANSITIONS[api.status].includes(status)) {
      throw new BusinessRuleError('INVALID_TRANSITION', `Passage de ${api.status} à ${status} non autorisé.`);
    }
    const from = api.status;
    api.status = status;
    const saved = await this.repo.save(api);
    await this.audit.record({ actor, action: 'api.status_changed', objectType: 'api', objectId: id, details: { from, to: status } });
    await this.sync.trySync(`service ${api.slug} : ${from} -> ${status}`);
    return saved;
  }
}

@Controller('apis')
@Section('catalogue')
@UseGuards(ConsoleGuard)
export class ApisController {
  constructor(private readonly service: ApisService) {}

  @Get()
  list(@Query('status') status?: ApiStatus, @Query('providerId') providerId?: string) {
    return this.service.list({ status, providerId });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() dto: CreateApiDto, @Actor() actor: string) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateApiDto, @Actor() actor: string) {
    return this.service.update(id, dto, actor);
  }

  @Post(':id/status')
  changeStatus(@Param('id') id: string, @Body() dto: ChangeApiStatusDto, @Actor() actor: string) {
    return this.service.changeStatus(id, dto.status, actor);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([ApiProduct, Provider]), AuditModule, GatewayModule],
  providers: [ApisService],
  controllers: [ApisController],
})
export class ApisModule {}
