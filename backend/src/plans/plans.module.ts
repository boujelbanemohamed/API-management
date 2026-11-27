import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApprovalMode, OveragePolicy, Plan } from './plan.entity';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { GatewayModule } from '../gateway/gateway.module';
import { GatewaySyncService } from '../gateway/gateway-sync.service';
import { ConsoleGuard, Section } from '../auth/guards';
import { Actor } from '../common/actor.decorator';
import { diff, findOr404 } from '../common/crud';
import { BusinessRuleError } from '../subscriptions/subscription-rules';

export class CreatePlanDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyFee?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pricePerCall?: number;

  @IsString()
  @Length(2, 80)
  name: string;

  @IsInt()
  @Min(1)
  dailyQuota: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyQuota?: number;

  @IsInt()
  @Min(1)
  @Max(10000)
  rateLimitPerSecond: number;

  @IsOptional()
  @IsEnum(OveragePolicy)
  overagePolicy?: OveragePolicy;

  @IsOptional()
  @IsEnum(ApprovalMode)
  approval?: ApprovalMode;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyFee?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pricePerCall?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  dailyQuota?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyQuota?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  rateLimitPerSecond?: number;

  @IsOptional()
  @IsEnum(OveragePolicy)
  overagePolicy?: OveragePolicy;

  @IsOptional()
  @IsEnum(ApprovalMode)
  approval?: ApprovalMode;

  /** Un plan inactif n'accepte plus de nouveaux abonnements ; les abonnements en cours le gardent. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

@Injectable()
export class PlansService {
  constructor(
    @InjectRepository(Plan) private readonly repo: Repository<Plan>,
    private readonly audit: AuditService,
    private readonly sync: GatewaySyncService,
  ) {}

  list() {
    return this.repo.find({ order: { dailyQuota: 'ASC' } });
  }

  get(id: string) {
    return findOr404(this.repo, id, 'Plan');
  }

  async create(dto: CreatePlanDto, actor: string) {
    if (await this.repo.findOne({ where: { name: dto.name } })) {
      throw new BusinessRuleError('DUPLICATE_NAME', `Le plan « ${dto.name} » existe déjà.`);
    }
    if (dto.monthlyQuota !== undefined && dto.monthlyQuota < dto.dailyQuota) {
      throw new BusinessRuleError('INVALID_QUOTA', 'Le quota mensuel ne peut pas être inférieur au quota journalier.');
    }
    const plan = await this.repo.save(this.repo.create(dto));
    await this.audit.record({ actor, action: 'plan.created', objectType: 'plan', objectId: plan.id, details: { name: plan.name } });
    return plan;
  }

  async update(id: string, dto: UpdatePlanDto, actor: string) {
    const plan = await this.get(id);
    const changes = diff(plan, dto);
    Object.assign(plan, dto);
    const saved = await this.repo.save(plan);
    if (Object.keys(changes).length) {
      // Modifier un plan s'applique immédiatement à tous les abonnements qui l'utilisent.
      await this.audit.record({ actor, action: 'plan.updated', objectType: 'plan', objectId: id, details: changes });
      await this.sync.trySync(`plan ${plan.name} modifié`);
    }
    return saved;
  }
}

@Controller('plans')
@Section('catalogue')
@UseGuards(ConsoleGuard)
export class PlansController {
  constructor(private readonly service: PlansService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() dto: CreatePlanDto, @Actor() actor: string) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto, @Actor() actor: string) {
    return this.service.update(id, dto, actor);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Plan]), AuditModule, GatewayModule],
  providers: [PlansService],
  controllers: [PlansController],
})
export class PlansModule {}
