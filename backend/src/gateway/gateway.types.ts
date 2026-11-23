/** Objets APISIX (API d'administration v3) gérés par la plateforme. */

export const MANAGED_LABEL = { managed_by: 'api-platform' } as const;

export interface ApisixConsumer {
  username: string;
  desc?: string;
  labels: Record<string, string>;
  plugins: Record<string, unknown>;
}

export interface ApisixRoute {
  id: string;
  name: string;
  uris: string[];
  status: 0 | 1;
  labels: Record<string, string>;
  upstream: {
    type: 'roundrobin';
    scheme: 'http' | 'https';
    nodes: Record<string, number>;
    timeout: { connect: number; send: number; read: number };
    retries: number;
    pass_host: 'node';
  };
  plugins: Record<string, unknown>;
}

/** Droits d'un partenaire sur une API, lus par le plugin subscription-guard dans Valkey. */
export interface AccessRight {
  /** active = l'abonnement laisse passer les appels ; sinon raison du refus. */
  status: 'active' | 'inactive';
  reason?: 'pending' | 'suspended' | 'expired' | 'partner_inactive' | 'not_started' | 'no_ip_allowlist';
  subscription_id: string;
  start: string;
  end: string;
  daily_quota: number;
  rate_per_second: number;
  overage: 'BLOCK' | 'ALLOW_AND_BILL' | 'ALERT_ONLY';
  allowed_ips: string[];
}

export interface GatewayConfig {
  consumers: ApisixConsumer[];
  routes: ApisixRoute[];
  /** Clé Valkey (sans préfixe) -> droit. Clé : sub:<consumer>:<route_id> */
  rights: Record<string, AccessRight>;
}
