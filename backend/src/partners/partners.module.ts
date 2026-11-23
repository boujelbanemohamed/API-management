import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Partner, PartnerStatus } from './partner.entity';
import { PartnersService } from './partners.service';
import { CreatePartnerDto, ReasonDto, UpdatePartnerDto } from './partners.dto';
import { Subscription } from '../subscriptions/subscription.entity';
import { AuditModule } from '../audit/audit.module';
import { GatewayModule } from '../gateway/gateway.module';
import { ConsoleGuard, Section } from '../auth/guards';
import { Actor } from '../common/actor.decorator';

/** Présentation : on ne renvoie jamais l'empreinte complète de la clé. */
function view(p: Partner) {
  const { apiKeyHash, ...rest } = p;
  return { ...rest, hasApiKey: apiKeyHash !== null && apiKeyHash !== undefined };
}

@Controller('partners')
@Section('banques')
@UseGuards(ConsoleGuard)
export class PartnersController {
  constructor(private readonly service: PartnersService) {}

  @Get()
  async list(@Query('status') status?: PartnerStatus) {
    return (await this.service.list(status)).map(view);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return view(await this.service.get(id));
  }

  @Post()
  async create(@Body() dto: CreatePartnerDto, @Actor() actor: string) {
    return view(await this.service.create(dto, actor));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdatePartnerDto, @Actor() actor: string) {
    return view(await this.service.update(id, dto, actor));
  }

  @Post(':id/activate')
  @HttpCode(200)
  async activate(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: string) {
    return view(await this.service.changeStatus(id, 'activate', actor, dto.reason));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  async suspend(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: string) {
    return view(await this.service.changeStatus(id, 'suspend', actor, dto.reason));
  }

  @Post(':id/terminate')
  @HttpCode(200)
  async terminate(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: string) {
    return view(await this.service.changeStatus(id, 'terminate', actor, dto.reason));
  }

  @Post(':id/api-key')
  async issueApiKey(@Param('id') id: string, @Actor() actor: string) {
    return this.service.issueApiKey(id, actor);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Partner, Subscription]), AuditModule, GatewayModule],
  providers: [PartnersService],
  controllers: [PartnersController],
  exports: [PartnersService],
})
export class PartnersModule {}
