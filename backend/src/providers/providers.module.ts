import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsEnum, IsInt, IsOptional, IsString, IsUrl, Length, Max, Min } from 'class-validator';
import { Provider, ProviderKind, ProviderStatus } from './provider.entity';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { GatewayModule } from '../gateway/gateway.module';
import { GatewaySyncService } from '../gateway/gateway-sync.service';
import { ConsoleGuard, Section } from '../auth/guards';
import { Actor } from '../common/actor.decorator';
import { diff, findOr404 } from '../common/crud';
import { BusinessRuleError } from '../subscriptions/subscription-rules';

const URL_OPTIONS = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

export class CreateProviderDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @IsOptional()
  @IsEnum(ProviderKind)
  kind?: ProviderKind;

  @IsUrl(URL_OPTIONS)
  baseUrl: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  sandboxBaseUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(120000)
  timeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  retries?: number;
}

export class UpdateProviderDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  baseUrl?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  sandboxBaseUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(120000)
  timeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  retries?: number;

  /** MAINTENANCE ou DISABLED : la passerelle répond 503 sur toutes les API de ce fournisseur. */
  @IsOptional()
  @IsEnum(ProviderStatus)
  status?: ProviderStatus;
}

@Injectable()
export class ProvidersService {
  constructor(
    @InjectRepository(Provider) private readonly repo: Repository<Provider>,
    private readonly audit: AuditService,
    private readonly sync: GatewaySyncService,
  ) {}

  list() {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  get(id: string) {
    return findOr404(this.repo, id, 'Fournisseur');
  }

  async create(dto: CreateProviderDto, actor: string) {
    if (await this.repo.findOne({ where: { name: dto.name } })) {
      throw new BusinessRuleError('DUPLICATE_NAME', `Le fournisseur « ${dto.name} » existe déjà.`);
    }
    const provider = await this.repo.save(this.repo.create(dto));
    await this.audit.record({ actor, action: 'provider.created', objectType: 'provider', objectId: provider.id, details: { name: dto.name } });
    return provider;
  }

  async update(id: string, dto: UpdateProviderDto, actor: string) {
    const provider = await this.get(id);
    const changes = diff(provider, dto);
    Object.assign(provider, dto);
    const saved = await this.repo.save(provider);
    if (Object.keys(changes).length) {
      await this.audit.record({ actor, action: 'provider.updated', objectType: 'provider', objectId: id, details: changes });
      await this.sync.trySync(`fournisseur ${provider.name} modifié`);
    }
    return saved;
  }
}

@Controller('providers')
@Section('catalogue')
@UseGuards(ConsoleGuard)
export class ProvidersController {
  constructor(private readonly service: ProvidersService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() dto: CreateProviderDto, @Actor() actor: string) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProviderDto, @Actor() actor: string) {
    return this.service.update(id, dto, actor);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Provider]), AuditModule, GatewayModule],
  providers: [ProvidersService],
  controllers: [ProvidersController],
})
export class ProvidersModule {}
