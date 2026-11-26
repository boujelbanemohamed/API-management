/**
 * Configuration lue depuis les variables d'environnement.
 * Voir `.env.example` pour la liste complète.
 */
export interface AppConfig {
  port: number;
  adminApiToken: string;
  usageIngestToken: string;
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    synchronize: boolean;
  };
  apisix: {
    adminUrl: string;
    adminKey: string;
    /** URL à laquelle APISIX envoie les événements d'usage (http-logger). */
    usageCallbackUrl: string;
    /** Environnement servi par cette passerelle : une instance APISIX par environnement. */
    environment: 'SANDBOX' | 'PRODUCTION';
  };
  /** Couche d'intégration : RabbitMQ (vide = bus en mémoire, réservé aux tests et au poste de développement). */
  integration?: {
    amqpUrl: string;
    relayIntervalMs: number;
  };
  /** Services opérationnels : adresse de chaque fournisseur (route APISIX en production, simulateur en sandbox). */
  operations?: {
    urls: { svip: string; p1: string; cockpit: string };
    /** Clé de consommateur APISIX du back-end, si les routes l'exigent. */
    apiKey: string;
    timeoutMs: number;
  };
  keycloak: {
    /** Émetteur attendu dans les jetons (adresse publique du royaume). */
    issuerUrl: string;
    /** Clés publiques du royaume, lues par l'adresse interne. */
    jwksUrl: string;
    consoleClientId: string;
    portalClientId: string;
  };
  valkey: {
    url: string;
    keyPrefix: string;
  };
  /** Mises en service (spécifications §10). Absent = règle appliquée. */
  onboarding?: {
    /** Refuser tout abonnement de production sans mise en service validée (PV signé banque + SMT). */
    enforceForProduction: boolean;
  };
  sync: {
    /** Intervalle de réconciliation complète avec la passerelle, en secondes (0 = désactivé). */
    intervalSeconds: number;
  };
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    adminApiToken: required('ADMIN_API_TOKEN'),
    usageIngestToken: required('USAGE_INGEST_TOKEN'),
    database: {
      host: required('DB_HOST', 'localhost'),
      port: Number(process.env.DB_PORT ?? 5432),
      username: required('DB_USER', 'apiplatform'),
      password: required('DB_PASSWORD'),
      database: required('DB_NAME', 'apiplatform'),
      synchronize: process.env.DB_SYNCHRONIZE === 'true',
    },
    apisix: {
      adminUrl: required('APISIX_ADMIN_URL', 'http://apisix:9180'),
      adminKey: required('APISIX_ADMIN_KEY'),
      usageCallbackUrl: required('USAGE_CALLBACK_URL', 'http://backend:3000/internal/usage'),
      environment: process.env.GATEWAY_ENVIRONMENT === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION',
    },
    integration: {
      amqpUrl: process.env.AMQP_URL ?? '',
      relayIntervalMs: Number(process.env.OUTBOX_RELAY_MS ?? 1000),
    },
    operations: {
      urls: { svip: process.env.OPS_SVIP_URL ?? '', p1: process.env.OPS_P1_URL ?? '', cockpit: process.env.OPS_COCKPIT_URL ?? '' },
      apiKey: process.env.OPS_API_KEY ?? '',
      timeoutMs: Number(process.env.OPS_TIMEOUT_MS ?? 5000),
    },
    keycloak: {
      issuerUrl: required('KEYCLOAK_ISSUER', 'http://localhost:8081/realms/smt'),
      jwksUrl: required('KEYCLOAK_JWKS_URL', 'http://keycloak:8080/realms/smt/protocol/openid-connect/certs'),
      consoleClientId: process.env.KEYCLOAK_CONSOLE_CLIENT ?? 'console',
      portalClientId: process.env.KEYCLOAK_PORTAL_CLIENT ?? 'portail',
    },
    valkey: {
      url: required('VALKEY_URL', 'redis://valkey:6379'),
      keyPrefix: process.env.VALKEY_KEY_PREFIX ?? 'apigw',
    },
    onboarding: { enforceForProduction: process.env.ONBOARDING_ENFORCE !== 'false' },
    sync: {
      intervalSeconds: Number(process.env.GATEWAY_SYNC_INTERVAL_SECONDS ?? 300),
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
