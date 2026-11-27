import { Controller, DynamicModule, Get, Global, Inject, Logger, Module, Provider as NestProvider, Res } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InMemoryBus, MESSAGE_BUS, MessageBus, RabbitBus } from './integration/message-bus';
import { InboxMessage, OutboxMessage } from './integration/outbox';
import { IntegrationModule } from './integration/integration.module';
import { ClamdScanner, FILE_STORE, FileStore, SeaweedFilerStore, VIRUS_SCANNER, VirusScanner } from './files/storage';
import { FilesModule, StoredFile } from './files/files.module';
import { Notification, NotificationsModule } from './notifications/notifications.module';
import { Content, ContentsModule, SurveyResponse } from './contents/contents.module';
import { UserDirectory, UsersModule, userDirectoryProvider } from './users/users.module';
import { BillingModule, Payment, Statement } from './billing/billing.module';
import { AssistantModule } from './assistant/assistant.module';
import { SupervisionModule } from './supervision/supervision.module';
import { OperationsClient, OperationsModule, operationsClientProvider } from './operations/operations.module';
import { KeycloakTokenVerifier, TOKEN_VERIFIER, TokenVerifier } from './auth/token-verifier';
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
import { Onboarding, OnboardingTestCase, TestBook } from './onboarding/onboarding.entities';
import { OnboardingModule } from './onboarding/onboarding.module';
import { Dispute, DisputeEvent, DisputesModule } from './disputes/disputes.module';
import { PortalModule } from './portal/portal.module';
import { ConsoleMeController } from './auth/console-me.controller';

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
  TestBook,
  Dispute,
  DisputeEvent,
  OutboxMessage,
  InboxMessage,
  StoredFile,
  Notification,
  Content,
  SurveyResponse,
  Statement,
  Payment,
];

export interface AppModuleOptions {
  config: AppConfig;
  /** Par défaut : PostgreSQL d'après la configuration. Les tests passent une base sql.js en mémoire. */
  database?: TypeOrmModuleOptions;
  clock?: Clock;
  gatewayAdmin?: GatewayAdmin;
  rightsStore?: RightsStore;
  /** Par défaut : clés publiques de Keycloak. Les tests fournissent leurs propres clés. */
  tokenVerifier?: TokenVerifier;
  /** Par défaut : RabbitMQ (AMQP_URL), sinon bus en mémoire. */
  messageBus?: MessageBus;
  /** Par défaut : HTTP vers les adresses OPS_*_URL. */
  operationsClient?: OperationsClient;
  fileStore?: FileStore;
  virusScanner?: VirusScanner;
  userDirectory?: UserDirectory;
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
        provide: MESSAGE_BUS,
        useFactory: () => {
          if (options.messageBus) return options.messageBus;
          const url = config.integration?.amqpUrl;
          if (!url) {
            new Logger('Integration').warn('AMQP_URL absent : bus en mémoire (aucun connecteur ne recevra les messages)');
            return new InMemoryBus();
          }
          return new RabbitBus(url);
        },
      },
      operationsClientProvider(config, options.operationsClient),
      userDirectoryProvider(config, options.userDirectory),
      { provide: FILE_STORE, useFactory: () => options.fileStore ?? new SeaweedFilerStore(config.files?.filerUrl ?? 'http://seaweedfs:8888') },
      { provide: VIRUS_SCANNER, useFactory: () => options.virusScanner ?? new ClamdScanner(config.files?.clamavHost ?? 'clamav', config.files?.clamavPort ?? 3310) },
      {
        provide: TOKEN_VERIFIER,
        useFactory: () =>
          options.tokenVerifier ?? new KeycloakTokenVerifier(config.keycloak.issuerUrl, config.keycloak.jwksUrl),
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
        IntegrationModule,
        NotificationsModule,
        PortalModule,
        OperationsModule,
        FilesModule,
        ContentsModule,
        UsersModule,
        BillingModule,
        AssistantModule,
        SupervisionModule,
      ],
      controllers: [HealthController, ConsoleMeController],
    };
  }
}
