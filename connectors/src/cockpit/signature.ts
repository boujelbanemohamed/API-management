import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature des webhooks du Cockpit : HMAC-SHA256 (hexadécimal) de « horodatage.corps brut », avec un secret partagé.
 * Le même schéma signe les ordres envoyés au Cockpit.
 */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export const MAX_SKEW_MS = 5 * 60_000;

export type Verdict = 'ok' | 'missing' | 'expired' | 'invalid';

/** Vérifie la signature et la fraîcheur (fenêtre de 5 minutes contre le rejeu). */
export function verify(secret: string, timestamp: string | undefined, signature: string | undefined, rawBody: string, now = Date.now()): Verdict {
  if (!timestamp || !signature) return 'missing';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return 'expired';
  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'ok' : 'invalid';
}
