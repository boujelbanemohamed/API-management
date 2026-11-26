import { Controller, Get, HttpException, HttpStatus, Inject, Injectable, Module, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG, AppConfig } from '../config';
import { BankContext, PortalArea, PortalGuard } from '../auth/guards';
import { Bank } from '../portal/bank.decorator';
import { Partner } from '../partners/partner.entity';

/**
 * Services opérationnels (spécifications §12) : la plateforme lit les données des fournisseurs
 * et les présente à la banque. Chaque fournisseur est un adaptateur dont l'adresse se règle par configuration
 * (en production : la route APISIX du service ; en sandbox : le simulateur).
 */
export type ProviderKey = 'svip' | 'p1' | 'cockpit';

export const PROVIDER_LABEL: Record<ProviderKey, string> = {
  svip: 'SVIP (SmartVista)',
  p1: 'Plateforme 1',
  cockpit: 'SMT Cockpit',
};

export interface OperationsClient {
  /** GET sur le fournisseur, au nom de la banque. `null` si l'élément n'existe pas. */
  get(provider: ProviderKey, path: string, partnerCode: string, query?: Record<string, string | undefined>): Promise<unknown>;
}
export const OPERATIONS_CLIENT = Symbol('OPERATIONS_CLIENT');

export class ProviderUnavailable extends HttpException {
  constructor(provider: ProviderKey) {
    super(
      { statusCode: 503, code: 'PROVIDER_UNAVAILABLE', message: `${PROVIDER_LABEL[provider]} est momentanément indisponible. Vous pouvez créer une demande à SMT.` },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** Adaptateur HTTP : adresse et clé par fournisseur lues dans la configuration. */
export class HttpOperationsClient implements OperationsClient {
  constructor(private readonly config: NonNullable<AppConfig['operations']>) {}

  async get(provider: ProviderKey, path: string, partnerCode: string, query: Record<string, string | undefined> = {}) {
    const base = this.config.urls[provider];
    if (!base) throw new ProviderUnavailable(provider);
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString();
    let res: Response;
    try {
      res = await fetch(`${base.replace(/\/$/, '')}/${path}${qs ? `?${qs}` : ''}`, {
        headers: { Accept: 'application/json', 'X-Partner-Code': partnerCode, ...(this.config.apiKey ? { apikey: this.config.apiKey } : {}) },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new ProviderUnavailable(provider);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ProviderUnavailable(provider);
    return res.json();
  }
}

// ---------- Garde-fous appliqués à toute donnée fournisseur ----------

const FULL_PAN = /\b(\d{6})\d{3,9}(\d{4})\b/g;

/** Masque tout numéro de carte complet qui aurait échappé au fournisseur (PCI-DSS). */
export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return value.replace(FULL_PAN, (m: string, a: string, b: string) => `${a}${'*'.repeat(m.length - 10)}${b}`) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  return value;
}

/** Ne garde que les données de la banque connectée, sans jamais faire confiance au fournisseur. */
export function ownOnly<T extends { bank?: string }>(items: unknown, partnerCode: string): Omit<T, 'bank'>[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is T => !!i && typeof i === 'object' && String((i as T).bank ?? '').toUpperCase() === partnerCode)
    .map(({ bank: _b, ...rest }) => maskDeep(rest));
}

function ownOne<T extends { bank?: string }>(item: unknown, partnerCode: string) {
  const [one] = ownOnly<T>(item ? [item] : [], partnerCode);
  if (!one) throw new NotFoundException('Introuvable');
  return one;
}

// ---------- BFF du portail ----------

@Injectable()
export class OperationsService {
  constructor(@Inject(OPERATIONS_CLIENT) private readonly client: OperationsClient) {}

  async list(provider: ProviderKey, path: string, bank: BankContext, query?: Record<string, string | undefined>) {
    const items = ownOnly(await this.client.get(provider, path, bank.partnerCode, query), bank.partnerCode);
    return { source: PROVIDER_LABEL[provider], items };
  }

  async one(provider: ProviderKey, path: string, bank: BankContext) {
    return { source: PROVIDER_LABEL[provider], item: ownOne(await this.client.get(provider, path, bank.partnerCode), bank.partnerCode) };
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const safeId = (id: string) => {
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(id)) throw new NotFoundException('Introuvable');
  return encodeURIComponent(id);
};

@Controller('portal/operations')
@UseGuards(PortalGuard)
@PortalArea('operations')
export class OperationsController {
  constructor(private readonly ops: OperationsService) {}

  @Get('transactions')
  transactions(@Bank() bank: BankContext, @Query('from') from?: string, @Query('to') to?: string, @Query('pan') pan?: string, @Query('reference') reference?: string, @Query('channel') channel?: string) {
    return this.ops.list('p1', 'transactions', bank, {
      from: from && DATE.test(from) ? from : undefined,
      to: to && DATE.test(to) ? to : undefined,
      pan: pan?.replace(/[^0-9*]/g, '').slice(0, 19),
      reference: reference?.slice(0, 40),
      channel: channel && ['TPE', 'GAB', 'E-COMMERCE'].includes(channel) ? channel : undefined,
      limit: '100',
    });
  }

  @Get('transactions/:reference')
  transaction(@Bank() bank: BankContext, @Param('reference') reference: string) {
    return this.ops.one('p1', `transactions/${safeId(reference)}`, bank);
  }

  @Get('cards')
  cards(@Bank() bank: BankContext, @Query('pan') pan?: string, @Query('holder') holder?: string, @Query('status') status?: string) {
    return this.ops.list('svip', 'cards', bank, { pan: pan?.replace(/[^0-9*]/g, '').slice(0, 19), holder: holder?.slice(0, 60), status: status && /^[A-Z]{3,12}$/.test(status) ? status : undefined });
  }

  @Get('cards/:id')
  card(@Bank() bank: BankContext, @Param('id') id: string) {
    return this.ops.one('svip', `cards/${safeId(id)}`, bank);
  }

  @Get('atms')
  atms(@Bank() bank: BankContext) {
    return this.ops.list('cockpit', 'atms', bank);
  }

  @Get('merchants')
  merchants(@Bank() bank: BankContext, @Query('name') name?: string) {
    return this.ops.list('cockpit', 'merchants', bank, { name: name?.slice(0, 60) });
  }

  @Get('affiliations')
  affiliations(@Bank() bank: BankContext) {
    return this.ops.list('cockpit', 'affiliations', bank);
  }

  @Get('smartvista-users')
  smartvistaUsers(@Bank() bank: BankContext) {
    return this.ops.list('svip', 'smartvista/users', bank);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Partner])],
  providers: [OperationsService],
  controllers: [OperationsController],
})
export class OperationsModule {}

/** Fournisseur de l'adaptateur (remplaçable dans les tests). */
export function operationsClientProvider(config: AppConfig, override?: OperationsClient) {
  return {
    provide: OPERATIONS_CLIENT,
    useFactory: () =>
      override ?? new HttpOperationsClient(config.operations ?? { urls: { svip: '', p1: '', cockpit: '' }, apiKey: '', timeoutMs: 5000 }),
  };
}
