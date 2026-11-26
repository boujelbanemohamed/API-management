import http from 'node:http';
import { log } from '../bus.js';
import { affiliations, atms, cards, merchants, smartvistaUsers, transactions } from './data.js';

/**
 * Simulateurs en lecture de la sandbox (interfaces supposées, à aligner sur les vrais contrats) :
 *   ROLE=svip     → GET /cards, /cards/:id, /smartvista/users          (SVIP vers SmartVista)
 *   ROLE=p1       → GET /transactions, /transactions/:reference          (Plateforme 1)
 *   ROLE=cockpit  → GET /atms, /merchants, /affiliations                 (SMT Cockpit, volet lecture)
 * La banque est indiquée par l'en-tête X-Partner-Code ; chaque simulateur ne renvoie que ses données.
 * FAIL_RATE (0..1) simule des pannes du fournisseur.
 */
const ROLE = process.env.ROLE ?? 'svip';
const PORT = Number(process.env.PORT ?? 8092);
const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0);

type Route = (bank: string, q: URLSearchParams, id?: string) => unknown;

const contains = (v: string, q: string | null) => !q || v.toLowerCase().includes(q.toLowerCase());

const ROUTES: Record<string, Record<string, Route>> = {
  svip: {
    cards: (b, q, id) => {
      const all = cards(b);
      if (id) return all.find((c) => c.id === id) ?? null;
      return all.filter((c) => contains(c.maskedPan, q.get('pan')) && contains(c.holder, q.get('holder')) && (!q.get('status') || c.status === q.get('status')));
    },
    'smartvista/users': (b) => smartvistaUsers(b),
  },
  p1: {
    transactions: (b, q, id) => {
      const all = transactions(b);
      if (id) return all.find((t) => t.reference === id) ?? null;
      const from = q.get('from') ?? '0000';
      const to = (q.get('to') ?? '9999') + 'T23:59:59';
      return all.filter((t) => t.date >= from && t.date <= to && contains(t.maskedPan, q.get('pan')) && contains(t.reference, q.get('reference')) && (!q.get('channel') || t.channel === q.get('channel'))).slice(0, Number(q.get('limit') ?? 50));
    },
  },
  cockpit: {
    atms: (b, _q, id) => (id ? (atms(b).find((a) => a.id === id) ?? null) : atms(b)),
    merchants: (b, q, id) => (id ? (merchants(b).find((m) => m.id === id) ?? null) : merchants(b).filter((m) => contains(m.name, q.get('name')))),
    affiliations: (b) => affiliations(b),
  },
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://sim');
    const send = (code: number, body: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/health') return send(200, { status: 'ok', role: ROLE });
    if (req.method !== 'GET') return send(405, { error: 'lecture seule' });
    const bank = String(req.headers['x-partner-code'] ?? '').toUpperCase();
    if (!/^[A-Z0-9_]{2,40}$/.test(bank)) return send(400, { error: 'X-Partner-Code requis' });
    if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) return send(503, { error: 'fournisseur indisponible (simulé)' });
    const routes = ROUTES[ROLE] ?? {};
    const path = url.pathname.replace(/^\//, '');
    const base = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}/`));
    if (!base) return send(404, { error: 'introuvable' });
    const id = path.length > base.length ? decodeURIComponent(path.slice(base.length + 1)) : undefined;
    const result = routes[base](bank, url.searchParams, id);
    return result === null ? send(404, { error: 'introuvable' }) : send(200, result);
  })
  .listen(PORT, () => log('info', `Simulateur ${ROLE} (lecture) à l'écoute sur ${PORT}`));
