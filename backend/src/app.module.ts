import { Controller, DynamicModule, Get, Global, Inject, Module, Provider as NestProvider, Res } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from './config';
import { CLOCK, Clock, systemClock } from './common/clock';
import { ApisixAdminClient, GATEWAY_ADMIN, GatewayAdmin } from './gateway/gateway-admin';
import { RIGHTS_STORE, RightsStore, ValkeyRightsStore } from './gateway/rights-store';
import { Partner } from './partners/partner.entity';
import { Provider } from './providers/provider.entity';
import { ApiProduct } from './apis/api-product.entity';
import { Plan } from './plans/plan.entity';
import { Subscription } from './subscriptions/subscription.entity';
import { UsageEvent } from './usage/usage-event.entity';
import { AuditEvent } from './audit/audit-event.entity';
import { AuditModule } from './audit/audit.module';
import { GatewayModule } from './gateway/gateway.module';
import { PartnersModule } from './partners/partners.module';
import { ProvidersModule } from './providers/providers.module';
import { ApisModule } from './apis/apis.module';
import { PlansModule } from './plans/plans.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UsageModule } from './usage/usage.module';
import { Holiday, ServiceCommitment, ServiceRequest } from './requests/request.entities';
import { RequestsModule } from './requests/requests.module';
import { Onboarding, OnboardingTestCase } from './onboarding/onboarding.entities';
import { OnboardingModule } from './onboarding/onboarding.module';
import { Dispute, DisputeEvent, DisputesModule } from './disputes/disputes.module';

export const ENTITIES = [
  Partner,
  Provider,
  ApiProduct,
  Plan,
  Subscription,
  UsageEvent,
  AuditEvent,
  ServiceRequest,
  Holiday,
  ServiceCommitment,
  Onboarding,
  OnboardingTestCase,
  Dispute,
  DisputeEvent,
];

export interface AppModuleOptions {
  config: AppConfig;
  /** Par défaut : PostgreSQL d'après la configuration. Les tests passent une base sql.js en mémoire. */
  database?: TypeOrmModuleOptions;
  clock?: Clock;
  gatewayAdmin?: GatewayAdmin;
  rightsStore?: RightsStore;
}

@Controller('health')
class HealthController {
  constructor(
    private readonly db: DataSource,
    @Inject(GATEWAY_ADMIN) private readonly gateway: GatewayAdmin,
    @Inject(RIGHTS_STORE) private readonly rights: RightsStore,
  ) {}

  /** Vivacité : le processus répond. */
  @Get()
  health() {
    return { status: 'ok' };
  }

  /** Disponibilité : la base, Valkey et l'API d'administration d'APISIX répondent (503 sinon). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok';
      } catch (e) {
        return `ko : ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    const checks = {
      database: await check(() => this.db.query('SELECT 1')),
      valkey: await check(() => this.rights.get('__ping__')),
      apisix: await check(() => this.gateway.listManagedRoutes()),
    };
    const ok = Object.values(checks).every((v) => v === 'ok');
    if (!ok) res.status(503);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}

@Global()
@Module({})
class CoreModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    const providers: NestProvider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: CLOCK, useValue: options.clock ?? systemClock },
      {
        provide: GATEWAY_ADMIN,
        useFactory: () => options.gatewayAdmin ?? new ApisixAdminClient(config.apisix.adminUrl, config.apisix.adminKey),
      },
      {
        provide: RIGHTS_STORE,
        useFactory: () =>
          options.rightsStore ??
          new ValkeyRightsStore(new Redis(config.valkey.url, { maxRetriesPerRequest: 2 }), config.valkey.keyPrefix),
      },
    ];
    return { module: CoreModule, providers, exports: providers.map((p: any) => p.provide) };
  }
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const db = options.config.database;
    return {
      module: AppModule,
      imports: [
        CoreModule.register(options),
        TypeOrmModule.forRoot(
          options.database
            ? { ...options.database, entities: ENTITIES }
            : {
                type: 'postgres',
                host: db.host,
                port: db.port,
                username: db.username,
                password: db.password,
                database: db.database,
                synchronize: db.synchronize,
                entities: ENTITIES,
              },
        ),
        AuditModule,
        GatewayModule,
        PartnersModule,
        ProvidersModule,
        ApisModule,
        PlansModule,
        SubscriptionsModule,
        UsageModule,
        RequestsModule,
        OnboardingModule,
        DisputesModule,
      ],
      controllers: [HealthController],
    };
  }
}
