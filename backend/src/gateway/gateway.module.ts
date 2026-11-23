import { Controller, Get, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminTokenGuard } from '../common/admin-token.guard';
import { Partner } from '../partners/partner.entity';
import { Provider } from '../providers/provider.entity';
import { ApiProduct } from '../apis/api-product.entity';
import { Plan } from '../plans/plan.entity';
import { Subscription } from '../subscriptions/subscription.entity';
import { GatewaySyncService } from './gateway-sync.service';

@Controller('gateway')
@UseGuards(AdminTokenGuard)
export class GatewayController {
  constructor(private readonly sync: GatewaySyncService) {}

  /** État de la dernière synchronisation (affiché dans la console : « Passerelle à jour / en écart »). */
  @Get('status')
  status() {
    return this.sync.lastReport() ?? { ok: false, reason: 'aucune synchronisation effectuée' };
  }

  /** Force une synchronisation complète. */
  @Post('sync')
  @HttpCode(200)
  async force() {
    return this.sync.trySync('demande manuelle');
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Partner, Provider, ApiProduct, Plan, Subscription])],
  providers: [GatewaySyncService],
  controllers: [GatewayController],
  exports: [GatewaySyncService],
})
export class GatewayModule {}
