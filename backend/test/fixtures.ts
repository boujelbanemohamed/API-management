import { Partner, PartnerStatus, PartnerType } from '../src/partners/partner.entity';
import { Provider, ProviderKind, ProviderStatus } from '../src/providers/provider.entity';
import { ApiProduct, ApiStatus, BillingUnit, SecurityLevel } from '../src/apis/api-product.entity';
import { ApprovalMode, OveragePolicy, Plan } from '../src/plans/plan.entity';
import { Environment, Subscription, SubscriptionStatus } from '../src/subscriptions/subscription.entity';
import { AppConfig } from '../src/config';

export const TEST_CONFIG: AppConfig = {
  port: 0,
  adminApiToken: 'admin-test-token',
  usageIngestToken: 'usage-test-token',
  database: { host: '', port: 0, username: '', password: '', database: '', synchronize: true },
  apisix: {
    adminUrl: 'http://apisix:9180',
    adminKey: 'k',
    usageCallbackUrl: 'http://backend:3000/internal/usage',
    environment: 'PRODUCTION',
  },
  valkey: { url: '', keyPrefix: 'apigw' },
  // Les tests historiques créent des abonnements de production directement.
  onboarding: { enforceForProduction: false },
  sync: { intervalSeconds: 0 },
};

export function partner(over: Partial<Partner> = {}): Partner {
  return Object.assign(new Partner(), {
    id: 'p-1',
    code: 'BNA',
    name: 'Banque Nationale Agricole',
    type: PartnerType.BANK,
    taxId: null,
    technicalContactEmail: null,
    billingContactEmail: null,
    status: PartnerStatus.ACTIVE,
    apiKeyHash: null,
    apiKeyCreatedAt: null,
    allowedIps: ['196.203.10.0/28'],
    ...over,
  });
}

export function provider(over: Partial<Provider> = {}): Provider {
  return Object.assign(new Provider(), {
    id: 'prov-1',
    name: 'Plateforme 1',
    kind: ProviderKind.INTERNAL,
    baseUrl: 'https://plateforme1.interne:8443/base',
    sandboxBaseUrl: 'http://simulateur-p1:8080',
    timeoutMs: 5000,
    retries: 1,
    status: ProviderStatus.OPERATIONAL,
    ...over,
  });
}

export function api(over: Partial<ApiProduct> = {}): ApiProduct {
  return Object.assign(new ApiProduct(), {
    id: 'api-1',
    name: 'Consultation des transactions',
    slug: 'transactions-v1',
    version: 'v1',
    description: null,
    publicPath: '/transactions/v1',
    upstreamPath: '/api/transactions',
    providerId: 'prov-1',
    status: ApiStatus.PUBLISHED,
    securityLevel: SecurityLevel.TOKEN_MTLS,
    billingUnit: BillingUnit.CALL,
    billFailedCalls: false,
    maskedFields: [],
    ...over,
  });
}

export function plan(over: Partial<Plan> = {}): Plan {
  return Object.assign(new Plan(), {
    id: 'plan-1',
    name: 'Standard',
    dailyQuota: 10000,
    monthlyQuota: null,
    rateLimitPerSecond: 20,
    overagePolicy: OveragePolicy.BLOCK,
    approval: ApprovalMode.MANUAL,
    active: true,
    ...over,
  });
}

export function subscription(over: Partial<Subscription> = {}): Subscription {
  return Object.assign(new Subscription(), {
    id: 'sub-1',
    partnerId: 'p-1',
    apiId: 'api-1',
    planId: 'plan-1',
    environment: Environment.PRODUCTION,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    customDailyQuota: null,
    status: SubscriptionStatus.ACTIVE,
    scheduledPlanId: null,
    scheduledPlanFrom: null,
    contractReference: null,
    ...over,
  });
}
