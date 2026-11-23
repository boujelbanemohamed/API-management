import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../config';
import { CLOCK, Clock } from '../common/clock';
import { Partner } from '../partners/partner.entity';
import { Provider } from '../providers/provider.entity';
import { ApiProduct } from '../apis/api-product.entity';
import { Plan } from '../plans/plan.entity';
import { Environment, Subscription } from '../subscriptions/subscription.entity';
import { buildGatewayConfig } from './gateway-config.builder';
import { GATEWAY_ADMIN, GatewayAdmin } from './gateway-admin';
import { RIGHTS_STORE, RightsStore } from './rights-store';

export interface SyncReport {
  ok: boolean;
  reason: string;
  startedAt: string;
  durationMs: number;
  consumers: { upserted: number; deleted: number };
  routes: { upserted: number; deleted: number };
  rights: { written: number; deleted: number };
  error?: string;
}

/**
 * Aligne la passerelle (APISIX + droits dans Valkey) sur les données métier.
 * - appelée après chaque modification métier (partenaire, API, plan, abonnement…) ;
 * - rejouée périodiquement pour réparer tout écart (passerelle redémarrée, appel manqué, changement de jour).
 * Les synchronisations sont exécutées l'une après l'autre, jamais en parallèle.
 */
@Injectable()
export class GatewaySyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GatewaySyncService.name);
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private last?: SyncReport;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(GATEWAY_ADMIN) private readonly admin: GatewayAdmin,
    @Inject(RIGHTS_STORE) private readonly rightsStore: RightsStore,
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    @InjectRepository(Provider) private readonly providers: Repository<Provider>,
    @InjectRepository(ApiProduct) private readonly apis: Repository<ApiProduct>,
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(Subscription) private readonly subscriptions: Repository<Subscription>,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.sync.intervalSeconds;
    if (seconds > 0) {
      void this.trySync('démarrage');
      this.timer = setInterval(() => void this.trySync('réconciliation périodique'), seconds * 1000);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  lastReport(): SyncReport | undefined {
    return this.last;
  }

  /** Synchronise et lève une erreur en cas d'échec. */
  syncAll(reason: string): Promise<SyncReport> {
    const run = this.chain.catch(() => undefined).then(() => this.run(reason));
    this.chain = run;
    return run.then((report) => {
      if (!report.ok) throw new Error(report.error);
      return report;
    });
  }

  /**
   * Synchronise sans faire échouer l'opération métier appelante : la modification reste enregistrée
   * et la prochaine réconciliation périodique rattrapera la passerelle.
   */
  async trySync(reason: string): Promise<SyncReport> {
    try {
      return await this.syncAll(reason);
    } catch {
      return this.last as SyncReport;
    }
  }

  private async run(reason: string): Promise<SyncReport> {
    const started = Date.now();
    const report: SyncReport = {
      ok: false,
      reason,
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      consumers: { upserted: 0, deleted: 0 },
      routes: { upserted: 0, deleted: 0 },
      rights: { written: 0, deleted: 0 },
    };
    try {
      const [partners, providers, apis, plans, subscriptions] = await Promise.all([
        this.partners.find(),
        this.providers.find(),
        this.apis.find(),
        this.plans.find(),
        this.subscriptions.find(),
      ]);
      const desired = buildGatewayConfig({
        environment: this.config.apisix.environment as Environment,
        today: this.clock.today(),
        partners,
        providers,
        apis,
        plans,
        subscriptions,
        usageCallbackUrl: this.config.apisix.usageCallbackUrl,
        usageIngestToken: this.config.usageIngestToken,
      });

      // 1. Consumers puis routes (créations et mises à jour).
      for (const consumer of desired.consumers) await this.admin.putConsumer(consumer);
      report.consumers.upserted = desired.consumers.length;
      for (const route of desired.routes) await this.admin.putRoute(route);
      report.routes.upserted = desired.routes.length;

      // 2. Droits : écrits avant les suppressions pour qu'aucun appel légitime ne soit refusé pendant la synchro.
      report.rights = await this.rightsStore.replaceAll(desired.rights);

      // 3. Suppression de ce qui n'existe plus côté métier (uniquement les objets gérés par la plateforme).
      const wantedRoutes = new Set(desired.routes.map((r) => r.id));
      for (const id of await this.admin.listManagedRoutes()) {
        if (!wantedRoutes.has(id)) {
          await this.admin.deleteRoute(id);
          report.routes.deleted++;
        }
      }
      const wantedConsumers = new Set(desired.consumers.map((c) => c.username));
      for (const username of await this.admin.listManagedConsumers()) {
        if (!wantedConsumers.has(username)) {
          await this.admin.deleteConsumer(username);
          report.consumers.deleted++;
        }
      }
      report.ok = true;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      this.logger.error(`Synchronisation passerelle en échec (${reason}) : ${report.error}`);
    }
    report.durationMs = Date.now() - started;
    this.last = report;
    return report;
  }
}
