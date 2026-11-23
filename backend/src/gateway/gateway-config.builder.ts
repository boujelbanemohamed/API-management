import { Partner, PartnerStatus } from '../partners/partner.entity';
import { Provider, ProviderStatus } from '../providers/provider.entity';
import { ApiProduct, ApiStatus } from '../apis/api-product.entity';
import { Plan } from '../plans/plan.entity';
import { Environment, Subscription, SubscriptionStatus } from '../subscriptions/subscription.entity';
import { effectiveDailyQuota, grantsAccess, planIdAt, LIVE_STATUSES } from '../subscriptions/subscription-rules';
import { AccessRight, ApisixConsumer, ApisixRoute, GatewayConfig, MANAGED_LABEL } from './gateway.types';

export interface BuildInput {
  environment: Environment;
  today: string;
  partners: Partner[];
  providers: Provider[];
  apis: ApiProduct[];
  plans: Plan[];
  subscriptions: Subscription[];
  usageCallbackUrl: string;
  usageIngestToken: string;
}

/**
 * Calcule la configuration attendue de la passerelle à partir des données métier.
 * Fonction pure : la même entrée donne toujours la même sortie, ce qui rend la
 * synchronisation idempotente (on peut la rejouer sans risque).
 */
export function buildGatewayConfig(input: BuildInput): GatewayConfig {
  const providers = new Map(input.providers.map((p) => [p.id, p]));
  const plans = new Map(input.plans.map((p) => [p.id, p]));
  const partners = new Map(input.partners.map((p) => [p.id, p]));
  const apis = new Map(input.apis.map((a) => [a.id, a]));

  const consumers: ApisixConsumer[] = input.partners
    .filter((p) => p.status !== PartnerStatus.TERMINATED)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => ({
      username: consumerName(p),
      desc: p.name,
      labels: { ...MANAGED_LABEL, partner_id: p.id },
      // Les identifiants (clé d'API, puis certificat / OAuth2) sont des « credentials » APISIX séparés :
      // la synchronisation ne les écrase jamais.
      plugins: {},
    }));

  const routes: ApisixRoute[] = input.apis
    .filter((api) => isRoutable(api, input.environment))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((api) => buildRoute(api, providers.get(api.providerId), input));

  const rights: Record<string, AccessRight> = {};
  const routable = new Set(routes.map((r) => r.id));
  // Les abonnements expirés gardent un droit « inactif » : la banque reçoit un refus explicite (abonnement expiré)
  // plutôt qu'un simple « aucun abonnement ». En cas de doublon, l'abonnement vivant l'emporte.
  const candidates = input.subscriptions
    .filter((s) => s.environment === input.environment && RIGHT_STATUSES.includes(s.status))
    .sort((a, b) => Number(LIVE_STATUSES.includes(a.status)) - Number(LIVE_STATUSES.includes(b.status)));
  for (const sub of candidates) {
    const partner = partners.get(sub.partnerId);
    const api = apis.get(sub.apiId);
    const plan = plans.get(planIdAt(sub, input.today));
    if (!partner || !api || !plan || partner.status === PartnerStatus.TERMINATED || !routable.has(api.slug)) continue;
    rights[rightKey(consumerName(partner), api.slug)] = buildRight(sub, partner, plan, input.today, input.environment);
  }

  return { consumers, routes, rights };
}

const RIGHT_STATUSES = [...LIVE_STATUSES, SubscriptionStatus.EXPIRED];

export function consumerName(partner: Partner): string {
  return partner.code.toLowerCase();
}

export function rightKey(consumer: string, routeId: string): string {
  return `sub:${consumer}:${routeId}`;
}

function isRoutable(api: ApiProduct, env: Environment): boolean {
  if (api.status === ApiStatus.PUBLISHED || api.status === ApiStatus.DEPRECATED) return true;
  return api.status === ApiStatus.BETA && env === Environment.SANDBOX;
}

function buildRoute(api: ApiProduct, provider: Provider | undefined, input: BuildInput): ApisixRoute {
  if (!provider) {
    throw new Error(`Fournisseur introuvable pour l'API ${api.slug}`);
  }
  const base = input.environment === Environment.SANDBOX && provider.sandboxBaseUrl ? provider.sandboxBaseUrl : provider.baseUrl;
  const url = new URL(base);
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port || (scheme === 'https' ? '443' : '80');
  const timeoutSeconds = Math.max(1, Math.round(provider.timeoutMs / 1000));
  const publicPath = trimSlash(api.publicPath);
  const upstreamPath = joinPath(url.pathname, api.upstreamPath);

  const plugins: Record<string, unknown> = {
    'request-id': { header_name: 'X-Request-Id', include_in_response: true },
    'key-auth': { header: 'apikey', hide_credentials: true },
    'subscription-guard': {},
    'proxy-rewrite': { regex_uri: [`^${escapeRegex(publicPath)}(.*)$`, `${upstreamPath}$1`] },
    'http-logger': {
      uri: input.usageCallbackUrl,
      auth_header: `Bearer ${input.usageIngestToken}`,
      batch_max_size: 200,
      inactive_timeout: 5,
      include_req_body: false,
      include_resp_body: false,
      concat_method: 'json',
    },
  };

  if (provider.status !== ProviderStatus.OPERATIONAL) {
    // Fournisseur en maintenance ou désactivé : réponse 503 explicite au lieu d'un appel en échec.
    plugins['fault-injection'] = {
      abort: {
        http_status: 503,
        body: '{"error":"service_unavailable","message":"Service momentanément indisponible."}',
      },
    };
  }

  return {
    id: api.slug,
    name: `${api.name} (${api.version})`,
    uris: [publicPath, `${publicPath}/*`],
    status: 1,
    labels: { ...MANAGED_LABEL, api_id: api.id },
    upstream: {
      type: 'roundrobin',
      scheme,
      nodes: { [`${url.hostname}:${port}`]: 1 },
      timeout: { connect: timeoutSeconds, send: timeoutSeconds, read: timeoutSeconds },
      retries: provider.retries,
      pass_host: 'node',
    },
    plugins,
  };
}

function buildRight(sub: Subscription, partner: Partner, plan: Plan, today: string, env: Environment): AccessRight {
  const right: AccessRight = {
    status: grantsAccess(sub, partner, today) ? 'active' : 'inactive',
    subscription_id: sub.id,
    start: sub.startDate,
    end: sub.endDate,
    daily_quota: effectiveDailyQuota(sub, plan),
    rate_per_second: plan.rateLimitPerSecond,
    overage: plan.overagePolicy,
    allowed_ips: partner.allowedIps ?? [],
  };
  if (right.status === 'inactive') {
    right.reason = inactiveReason(sub, partner, today);
  } else if (env === Environment.PRODUCTION && right.allowed_ips.length === 0) {
    // En production, une institution sans adresse IP déclarée ne passe pas (sécurité bancaire).
    right.status = 'inactive';
    right.reason = 'no_ip_allowlist';
  }
  return right;
}

function inactiveReason(sub: Subscription, partner: Partner, today: string): AccessRight['reason'] {
  if (partner.status !== PartnerStatus.ACTIVE) return 'partner_inactive';
  if (sub.status === SubscriptionStatus.PENDING) return 'pending';
  if (sub.status === SubscriptionStatus.SUSPENDED) return 'suspended';
  if (sub.status === SubscriptionStatus.EXPIRED) return 'expired';
  if (today < sub.startDate) return 'not_started';
  return 'expired';
}

function trimSlash(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function joinPath(base: string, path: string): string {
  const joined = `${trimSlash(base)}${trimSlash(path)}`.replace(/\/{2,}/g, '/');
  return joined === '' ? '/' : trimSlash(joined);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
