import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Environment, Subscription, SubscriptionStatus } from './subscription.entity';
import { SubscriptionsService } from './subscriptions.service';
import { ChangePlanDto, CreateSubscriptionDto, RenewSubscriptionDto, UpdateQuotaDto } from './subscriptions.dto';
import { Partner } from '../partners/partner.entity';
import { ApiProduct } from '../apis/api-product.entity';
import { Plan } from '../plans/plan.entity';
import { ReasonDto } from '../partners/partners.dto';
import { AuditModule } from '../audit/audit.module';
import { GatewayModule } from '../gateway/gateway.module';
import { AdminTokenGuard } from '../common/admin-token.guard';
import { Actor } from '../common/actor.decorator';
import { Onboarding } from '../onboarding/onboarding.entities';

@Controller('subscriptions')
@UseGuards(AdminTokenGuard)
export class SubscriptionsController {
  constructor(private readonly service: SubscriptionsService) {}

  @Get()
  list(
    @Query('partnerId') partnerId?: string,
    @Query('apiId') apiId?: string,
    @Query('status') status?: SubscriptionStatus,
    @Query('environment') environment?: Environment,
  ) {
    return this.service.list({ partnerId, apiId, status, environment });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() dto: CreateSubscriptionDto, @Actor() actor: string) {
    return this.service.create(dto, actor);
  }

  @Post(':id/validate')
  @HttpCode(200)
  validate(@Param('id') id: string, @Actor() actor: string) {
    return this.service.validate(id, actor);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: string) {
    return this.service.reject(id, actor, dto.reason);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: string) {
    return this.service.suspend(id, actor, dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id') id: string, @Actor() actor: string) {
    return this.service.reactivate(id, actor);
  }

  @Post(':id/renew')
  @HttpCode(200)
  renew(@Param('id') id: string, @Body() dto: RenewSubscriptionDto, @Actor() actor: string) {
    return this.service.renew(id, dto.endDate, actor);
  }

  @Post(':id/change-plan')
  @HttpCode(200)
  changePlan(@Param('id') id: string, @Body() dto: ChangePlanDto, @Actor() actor: string) {
    return this.service.changePlan(id, dto, actor);
  }

  @Patch(':id/quota')
  setQuota(@Param('id') id: string, @Body() dto: UpdateQuotaDto, @Actor() actor: string) {
    return this.service.setCustomQuota(id, dto.customDailyQuota ?? null, actor);
  }

  @Post(':id/terminate')
  @HttpCode(200)
  terminate(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: string) {
    return this.service.terminate(id, actor, dto.reason);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Subscription, Partner, ApiProduct, Plan, Onboarding]), AuditModule, GatewayModule],
  providers: [SubscriptionsService],
  controllers: [SubscriptionsController],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
