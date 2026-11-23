import { buildGatewayConfig, BuildInput } from '../src/gateway/gateway-config.builder';
import { Environment, SubscriptionStatus } from '../src/subscriptions/subscription.entity';
import { PartnerStatus } from '../src/partners/partner.entity';
import { ApiStatus } from '../src/apis/api-product.entity';
import { ProviderStatus } from '../src/providers/provider.entity';
import { api, partner, plan, provider, subscription } from './fixtures';

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    environment: Environment.PRODUCTION,
    today: '2026-06-15',
    partners: [partner()],
    providers: [provider()],
    apis: [api()],
    plans: [plan()],
    subscriptions: [subscription()],
    usageCallbackUrl: 'http://backend:3000/internal/usage',
    usageIngestToken: 'tok',
    ...over,
  };
}

describe('Construction de la configuration passerelle', () => {
  it('produit consumer, route et droit actif', () => {
    const cfg = buildGatewayConfig(input());
    expect(cfg.consumers).toEqual([
      expect.objectContaining({ username: 'bna', labels: { managed_by: 'api-platform', partner_id: 'p-1' } }),
    ]);
    const route = cfg.routes[0];
    expect(route.id).toBe('transactions-v1');
    expect(route.uris).toEqual(['/transactions/v1', '/transactions/v1/*']);
    expect(route.upstream.nodes).toEqual({ 'plateforme1.interne:8443': 1 });
    expect(route.upstream.scheme).toBe('https');
    expect(route.plugins['proxy-rewrite']).toEqual({ regex_uri: ['^/transactions/v1(.*)$', '/base/api/transactions$1'] });
    expect(route.plugins['key-auth']).toBeDefined();
    expect(route.plugins['subscription-guard']).toBeDefined();
    expect(route.plugins['http-logger']).toMatchObject({ auth_header: 'Bearer tok' });
    expect(cfg.rights['sub:bna:transactions-v1']).toMatchObject({
      status: 'active',
      daily_quota: 10000,
      rate_per_second: 20,
      allowed_ips: ['196.203.10.0/28'],
    });
  });

  it('est déterministe (synchronisation idempotente)', () => {
    expect(buildGatewayConfig(input())).toEqual(buildGatewayConfig(input()));
  });

  it('écrit un droit inactif avec sa raison', () => {
    const cases: Array<[Partial<BuildInput>, string]> = [
      [{ partners: [partner({ status: PartnerStatus.SUSPENDED })] }, 'partner_inactive'],
      [{ subscriptions: [subscription({ status: SubscriptionStatus.PENDING })] }, 'pending'],
      [{ subscriptions: [subscription({ status: SubscriptionStatus.SUSPENDED })] }, 'suspended'],
      [{ today: '2025-12-01' }, 'not_started'],
      [{ today: '2027-01-02' }, 'expired'],
      [{ partners: [partner({ allowedIps: [] })] }, 'no_ip_allowlist'],
      [{ subscriptions: [subscription({ status: SubscriptionStatus.EXPIRED })] }, 'expired'],
    ];
    for (const [over, reason] of cases) {
      expect(buildGatewayConfig(input(over)).rights['sub:bna:transactions-v1']).toMatchObject({ status: 'inactive', reason });
    }
  });

  it('n’écrit aucun droit pour les abonnements terminés, refusés ou d’un autre environnement', () => {
    for (const s of [
      subscription({ status: SubscriptionStatus.TERMINATED }),
      subscription({ status: SubscriptionStatus.REJECTED }),
      subscription({ environment: Environment.SANDBOX }),
    ]) {
      expect(buildGatewayConfig(input({ subscriptions: [s] })).rights).toEqual({});
    }
  });

  it('fait primer l’abonnement vivant sur un ancien abonnement expiré', () => {
    const cfg = buildGatewayConfig(
      input({ subscriptions: [subscription({ id: 'new' }), subscription({ id: 'old', status: SubscriptionStatus.EXPIRED })] }),
    );
    expect(cfg.rights['sub:bna:transactions-v1']).toMatchObject({ status: 'active', subscription_id: 'new' });
  });

  it('retire le consumer d’un partenaire résilié', () => {
    const cfg = buildGatewayConfig(input({ partners: [partner({ status: PartnerStatus.TERMINATED })] }));
    expect(cfg.consumers).toEqual([]);
    expect(cfg.rights).toEqual({});
  });

  it('publie les API bêta en sandbox uniquement, jamais les brouillons ni les retirées', () => {
    const beta = [api({ status: ApiStatus.BETA })];
    expect(buildGatewayConfig(input({ apis: beta })).routes).toHaveLength(0);
    const sandbox = buildGatewayConfig(
      input({ apis: beta, environment: Environment.SANDBOX, subscriptions: [subscription({ environment: Environment.SANDBOX })] }),
    );
    expect(sandbox.routes[0].upstream.nodes).toEqual({ 'simulateur-p1:8080': 1 });
    expect(sandbox.rights['sub:bna:transactions-v1'].status).toBe('active'); // pas d'exigence d'IP en sandbox
    expect(buildGatewayConfig(input({ apis: [api({ status: ApiStatus.DRAFT })] })).routes).toHaveLength(0);
    expect(buildGatewayConfig(input({ apis: [api({ status: ApiStatus.RETIRED })] })).rights).toEqual({});
  });

  it('applique le plan programmé et le quota personnalisé', () => {
    const cfg = buildGatewayConfig(
      input({
        plans: [plan(), plan({ id: 'plan-2', name: 'Premium', dailyQuota: 50000, rateLimitPerSecond: 100 })],
        subscriptions: [subscription({ scheduledPlanId: 'plan-2', scheduledPlanFrom: '2026-06-01' })],
      }),
    );
    expect(cfg.rights['sub:bna:transactions-v1']).toMatchObject({ daily_quota: 50000, rate_per_second: 100 });
    const custom = buildGatewayConfig(input({ subscriptions: [subscription({ customDailyQuota: 42 })] }));
    expect(custom.rights['sub:bna:transactions-v1'].daily_quota).toBe(42);
  });

  it('répond 503 quand le fournisseur est en maintenance', () => {
    const cfg = buildGatewayConfig(input({ providers: [provider({ status: ProviderStatus.MAINTENANCE })] }));
    expect(cfg.routes[0].plugins['fault-injection']).toMatchObject({ abort: { http_status: 503 } });
  });
});
