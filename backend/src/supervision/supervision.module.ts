import { Controller, Get, Inject, Module, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConsoleGuard, Section } from '../auth/guards';
import { APP_CONFIG, AppConfig } from '../config';
import { GATEWAY_ADMIN, GatewayAdmin } from '../gateway/gateway-admin';
import { RIGHTS_STORE, RightsStore } from '../gateway/rights-store';
import { FILE_STORE, VIRUS_SCANNER, VirusScanner } from '../files/storage';
import { OutboxRelay } from '../integration/integration.module';
import { USER_DIRECTORY, UserDirectory } from '../users/users.module';

type Check = { name: string; status: 'ok' | 'ko' | 'non configuré'; detail?: string; ms?: number };

/** Paramètres et supervision (console, section Administration) : état des dépendances et de la messagerie. */
@Controller('console/supervision')
@UseGuards(ConsoleGuard)
@Section('administration')
export class SupervisionController {
  constructor(
    private readonly db: DataSource,
    @Inject(GATEWAY_ADMIN) private readonly gateway: GatewayAdmin,
    @Inject(RIGHTS_STORE) private readonly rights: RightsStore,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    @Inject(FILE_STORE) private readonly _store: unknown,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly relay: OutboxRelay,
  ) {}

  private async check(name: string, fn: () => Promise<unknown>): Promise<Check> {
    const t = Date.now();
    try {
      await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('délai dépassé')), 5000))]);
      return { name, status: 'ok', ms: Date.now() - t };
    } catch (e) {
      return { name, status: 'ko', detail: (e as Error).message.slice(0, 160), ms: Date.now() - t };
    }
  }

  private http(url: string) {
    return async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    };
  }

  @Get()
  async get() {
    const ops = this.config.operations?.urls ?? { svip: '', p1: '', cockpit: '' };
    const provider = async (name: string, base: string): Promise<Check> => (base ? this.check(name, this.http(`${base.replace(/\/$/, '')}/health`)) : { name, status: 'non configuré' });
    const checks = await Promise.all([
      this.check('Base de données (PostgreSQL)', () => this.db.query('SELECT 1')),
      this.check('Droits et quotas (Valkey)', () => this.rights.get('__ping__')),
      this.check('Passerelle (APISIX, administration)', () => this.gateway.listManagedRoutes()),
      this.check('Antivirus (ClamAV)', () => this.scanner.scan(Buffer.from('ping'))),
      this.config.files?.filerUrl ? this.check('Fichiers (SeaweedFS)', this.http(`${this.config.files.filerUrl}/`)) : Promise.resolve<Check>({ name: 'Fichiers (SeaweedFS)', status: 'non configuré' }),
      this.check('Annuaire (Keycloak, administration)', () => this.directory.list({ console: true })),
      provider('SVIP (SmartVista)', ops.svip),
      provider('Plateforme 1', ops.p1),
      provider('SMT Cockpit (lecture)', ops.cockpit),
    ]);
    const outbox = await this.relay.stats();
    const stuck = (await this.relay.pending()).slice(0, 20).map((m) => ({ id: m.id, topic: m.topic, status: m.status, attempts: m.attempts, lastError: m.lastError, createdAt: m.createdAt }));
    return {
      checks,
      outbox: { PENDING: outbox.PENDING ?? 0, PUBLISHED: outbox.PUBLISHED ?? 0, FAILED: outbox.FAILED ?? 0, stuck },
      settings: {
        environment: this.config.apisix.environment,
        onboardingEnforced: this.config.onboarding?.enforceForProduction !== false,
        broker: this.config.integration?.amqpUrl ? 'RabbitMQ' : 'mémoire (développement)',
        assistant: process.env.ASSISTANT_URL ? `modèle ${process.env.ASSISTANT_MODEL ?? ''}`.trim() : 'extraits seulement',
      },
    };
  }
}

@Module({ controllers: [SupervisionController] })
export class SupervisionModule {}
