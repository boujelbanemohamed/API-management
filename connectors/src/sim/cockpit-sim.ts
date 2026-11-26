import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { log } from '../bus.js';
import { sign, verify } from '../cockpit/signature.js';

/**
 * Simulateur SMT Cockpit (sandbox). POST /orders (signé) → 202, puis webhook signé après DELAY_MS :
 * DONE par défaut ; REJECTED si l'objet contient « REFUS » ; NEED_INFO s'il contient « INFO ».
 * Un même ordre reçu deux fois n'est traité qu'une fois.
 */
const PORT = Number(process.env.PORT ?? 8091);
const SECRET = process.env.COCKPIT_SHARED_SECRET ?? '';
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://connector-cockpit:8090/webhooks/cockpit';
const DELAY_MS = Number(process.env.DELAY_MS ?? 2000);
const seen = new Set<string>();

async function notify(orderId: string, subject: string) {
  const status = /REFUS/i.test(subject) ? 'REJECTED' : /INFO/i.test(subject) ? 'NEED_INFO' : 'DONE';
  const message = status === 'DONE' ? 'Opération exécutée' : status === 'REJECTED' ? 'Refus : terminal inconnu' : 'Merci de préciser le numéro de terminal';
  const body = JSON.stringify({ eventId: randomUUID(), orderId, status, message });
  const ts = String(Date.now());
  const res = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cockpit-Timestamp': ts, 'X-Cockpit-Signature': sign(SECRET, ts, body) }, body }).catch((e) => e as Error);
  log('info', 'Simulateur Cockpit : webhook envoyé', { orderId, status, result: res instanceof Error ? res.message : res.status });
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health') return res.writeHead(200).end('{"status":"ok"}');
      if (req.method !== 'POST' || req.url !== '/orders') return res.writeHead(404).end();
      if (verify(SECRET, req.headers['x-cockpit-timestamp'] as string, req.headers['x-cockpit-signature'] as string, raw) !== 'ok') return res.writeHead(401).end();
      const order = JSON.parse(raw) as { orderId: string; subject: string };
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"accepted":true}');
      if (seen.has(order.orderId)) return;
      seen.add(order.orderId);
      setTimeout(() => void notify(order.orderId, order.subject), DELAY_MS);
    });
  })
  .listen(PORT, () => log('info', `Simulateur Cockpit à l'écoute sur ${PORT}`));
