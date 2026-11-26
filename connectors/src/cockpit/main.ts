import http from 'node:http';
import { Bus, env, log, retry } from '../bus.js';
import { sign, verify } from './signature.js';

/**
 * Connecteur SMT Cockpit.
 * - cockpit.order (back-end) → POST {COCKPIT_URL}/orders, signé ;
 * - webhook POST /webhooks/cockpit (signature et fraîcheur vérifiées) → cockpit.event.
 * Le rejeu d'un webhook déjà reçu est écarté par le back-end (identifiant de l'événement).
 */
const bus = new Bus(env('AMQP_URL'));
const COCKPIT_URL = env('COCKPIT_URL');
const SECRET = env('COCKPIT_SHARED_SECRET');
const PORT = Number(env('PORT', '8090'));
const STATUSES = ['DONE', 'REJECTED', 'NEED_INFO', 'IN_PROGRESS'];

async function sendOrder(order: { requestId: string; partnerCode: string; service: string; subject: string; context: Record<string, string> }) {
  const body = JSON.stringify({ orderId: order.requestId, bank: order.partnerCode, service: order.service, subject: order.subject, context: order.context });
  await retry(async () => {
    const ts = String(Date.now());
    const res = await fetch(`${COCKPIT_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Timestamp': ts, 'X-Cockpit-Signature': sign(SECRET, ts, body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    // 4xx : ordre refusé définitivement (pas de nouvel essai) ; 5xx et réseau : nouvel essai.
    if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`Cockpit a refusé l'ordre (${res.status})`), { final: true });
    if (!res.ok) throw new Error(`Cockpit indisponible (${res.status})`);
  }, Number(env('COCKPIT_ATTEMPTS', '5'))).catch(async (e) => {
    // Échec définitif : la demande revient dans la file des agents SMT (traitement manuel), sans pénaliser la banque.
    await bus.publish('cockpit.event', { requestId: order.requestId, status: 'TRANSMISSION_FAILED', message: `Transmission au Cockpit impossible : ${(e as Error).message}` }, `${order.requestId}:transmission-failed`);
  });
  log('info', 'Ordre transmis au Cockpit', { requestId: order.requestId, service: order.service });
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('corps trop volumineux'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const reply = (code: number, body: object) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'ok' });
  if (req.method !== 'POST' || req.url !== '/webhooks/cockpit') return reply(404, { error: 'introuvable' });
  try {
    const raw = await readBody(req);
    const verdict = verify(SECRET, req.headers['x-cockpit-timestamp'] as string, req.headers['x-cockpit-signature'] as string, raw);
    if (verdict !== 'ok') {
      log('warn', 'Webhook Cockpit refusé', { verdict, ip: req.socket.remoteAddress });
      return reply(401, { error: 'signature invalide ou expirée' });
    }
    const ev = JSON.parse(raw) as { eventId?: string; orderId?: string; status?: string; message?: string };
    if (!ev.eventId || !ev.orderId || !STATUSES.includes(ev.status ?? '')) return reply(400, { error: 'événement incomplet' });
    await bus.publish('cockpit.event', { requestId: ev.orderId, status: ev.status, message: ev.message }, `cockpit:${ev.eventId}`);
    log('info', 'Webhook Cockpit reçu', { eventId: ev.eventId, orderId: ev.orderId, status: ev.status });
    return reply(202, { accepted: true });
  } catch (e) {
    log('error', `Webhook Cockpit : ${(e as Error).message}`);
    return reply(400, { error: 'requête invalide' });
  }
});

async function main() {
  await bus.consume('connector.cockpit', ['cockpit.order'], (d) => sendOrder(d.payload));
  server.listen(PORT, () => log('info', `Connecteur Cockpit démarré, webhooks sur le port ${PORT}`));
}

main().catch((e) => {
  log('error', `Démarrage impossible : ${(e as Error).message}`);
  process.exit(1);
});
process.on('SIGTERM', async () => {
  server.close();
  await bus.close();
  process.exit(0);
});
