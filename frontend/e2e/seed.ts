/**
 * Jeu de données de recette (idempotent) : banques, service, plan, utilisateurs Keycloak et une mise en service en recette.
 * Variables : BACKEND_URL (http://localhost:3000), ADMIN_API_TOKEN, KEYCLOAK_URL (http://localhost:8081),
 * KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD, E2E_PASSWORD (mot de passe des utilisateurs de recette).
 */
import { writeFileSync } from 'node:fs';

const B = process.env.BACKEND_URL ?? 'http://localhost:3000';
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Recette@2026!x';
const S = { Authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, 'x-actor': 'recette', 'Content-Type': 'application/json' };

export const USERS = {
  op: { username: 'e2e.op.bna', bank: 'BNA', role: 'banque-operateur-monetique' },
  lit: { username: 'e2e.lit.bna', bank: 'BNA', role: 'banque-gestionnaire-litiges' },
  litStb: { username: 'e2e.lit.stb', bank: 'STB', role: 'banque-gestionnaire-litiges' },
  dev: { username: 'e2e.dev.bna', bank: 'BNA', role: 'banque-developpeur' },
  rssi: { username: 'e2e.rssi.bna', bank: 'BNA', role: 'banque-admin-securite' },
  // Console SMT (pas de banque)
  ops1: { username: 'e2e.ops1', bank: '', role: 'console-agent-operations' },
  ops2: { username: 'e2e.ops2', bank: '', role: 'console-agent-operations' },
  arbitre: { username: 'e2e.arbitre', bank: '', role: 'console-arbitre' },
  integ: { username: 'e2e.integ', bank: '', role: 'console-agent-integration' },
  audit: { username: 'e2e.audit', bank: '', role: 'console-auditeur' },
  admin: { username: 'e2e.admin', bank: '', role: 'console-admin' },
};

async function call<T>(url: string, init: RequestInit & { ok?: number[] } = {}): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok && !(init.ok ?? []).includes(res.status)) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
const back = <T>(path: string, body?: unknown, ok?: number[]) =>
  call<T>(B + path, { method: body === undefined ? 'GET' : 'POST', headers: S, body: body === undefined ? undefined : JSON.stringify(body), ok });

async function partner(code: string): Promise<string> {
  const all = await back<{ id: string; code: string; status: string }[]>('/partners');
  let p = all.find((x) => x.code === code);
  if (!p) p = await back('/partners', { code, name: `Banque ${code}` });
  if (p.status !== 'ACTIVE') await back(`/partners/${p.id}/activate`, {});
  return p.id;
}

async function keycloakUsers() {
  const t = await call<{ access_token: string }>(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KEYCLOAK_ADMIN_USER ?? 'admin', password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? '' }),
  });
  const H = { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' };
  const R = `${KC}/admin/realms/smt`;
  for (const u of Object.values(USERS)) {
    await call(`${R}/users`, {
      method: 'POST', headers: H, ok: [409],
      body: JSON.stringify({
        username: u.username, email: `${u.username}@recette.tn`, firstName: 'Recette', lastName: u.bank || 'SMT', enabled: true, emailVerified: true,
        ...(u.bank ? { attributes: { partner_code: [u.bank] } } : {}), credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
      }),
    });
    const [found] = await call<{ id: string }[]>(`${R}/users?username=${u.username}&exact=true`, { headers: H });
    const role = await call(`${R}/roles/${u.role}`, { headers: H });
    await call(`${R}/users/${found.id}/role-mappings/realm`, { method: 'POST', headers: H, body: JSON.stringify([role]) });
  }
}

export default async function seed() {
  const bna = await partner('BNA');
  await partner('STB');
  const run = Date.now().toString(36);
  const prov = await back<{ id: string }>('/providers', { name: `Simulateur ${run}`, baseUrl: 'http://simulateur:8080', sandboxBaseUrl: 'http://simulateur:8080' });
  const api = await back<{ id: string }>('/apis', { name: `Services cartes ${run}`, slug: `cartes-${run}`, publicPath: `/cartes-${run}/v1`, upstreamPath: '/cards', providerId: prov.id, description: 'Opposition, réédition, plafonds' });
  await back(`/apis/${api.id}/status`, { status: 'PUBLISHED' });
  // Second service, libre pour la demande de mise en service faite dans le navigateur.
  const api2 = await back<{ id: string }>('/apis', { name: `Affiliation ${run}`, slug: `affil-${run}`, publicPath: `/affil-${run}/v1`, upstreamPath: '/affil', providerId: prov.id });
  await back(`/apis/${api2.id}/status`, { status: 'PUBLISHED' });
  const plan = await back<{ id: string }>('/plans', { name: `Standard ${run}`, dailyQuota: 5000, rateLimitPerSecond: 20 });

  // Mise en service amenée jusqu'à la recette, pour la signature du PV dans le navigateur.
  const o = await back<{ id: string }>('/onboardings', { partnerId: bna, apiId: api.id, planId: plan.id });
  await back(`/onboardings/${o.id}/advance`, {});
  await back(`/onboardings/${o.id}/contract`, { contractReference: `CTR-${run}`, validatedBy: 'juriste' });
  await back(`/onboardings/${o.id}/advance`, {});
  await back(`/onboardings/${o.id}/test-mode`, { testMode: 'AUTONOMOUS' });
  const c = await back<{ id: string }>(`/onboardings/${o.id}/cases`, { code: 'TC-01', title: 'Opposition de carte' });
  await back(`/onboardings/${o.id}/advance`, {});
  await call(`${B}/onboardings/${o.id}/cases/${c.id}`, { method: 'PATCH', headers: S, body: JSON.stringify({ status: 'PASSED', evidence: 'trace-e2e' }) });
  await back(`/onboardings/${o.id}/advance`, {});

  // Console : demande sensible (double validation), litige en arbitrage, recette signée par la banque.
  const req = await back<{ id: string }>('/requests', { partnerId: bna, type: 'OPERATION', subject: `Relever le plafond ${run}`, sensitive: true });
  const stb = await partner('STB');
  const d = await back<{ id: string }>('/disputes', { issuerId: bna, acquirerId: stb, transactionRef: `ARB-${run}`, maskedPan: '412345******2345', transactionDate: new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10), transactionAmount: 80000, reasonCode: '4853' });
  for (const a of [{ action: 'chargeback', party: 'ISSUER' }, { action: 'second-presentment', party: 'ACQUIRER' }, { action: 'second-chargeback', party: 'ISSUER', documentRef: 'nouveau' }, { action: 'arbitration-request', party: 'ACQUIRER' }]) {
    await back(`/disputes/${d.id}/actions`, a);
  }
  const api3 = await back<{ id: string }>('/apis', { name: `GAB ${run}`, slug: `gab-${run}`, publicPath: `/gab-${run}/v1`, upstreamPath: '/gab', providerId: prov.id });
  await back(`/apis/${api3.id}/status`, { status: 'PUBLISHED' });
  const o2 = await back<{ id: string }>('/onboardings', { partnerId: bna, apiId: api3.id, planId: plan.id });
  await back(`/onboardings/${o2.id}/advance`, {});
  await back(`/onboardings/${o2.id}/contract`, { contractReference: `CTR2-${run}`, validatedBy: 'juriste' });
  await back(`/onboardings/${o2.id}/advance`, {});
  await back(`/onboardings/${o2.id}/test-mode`, { testMode: 'AUTONOMOUS' });
  const c2 = await back<{ id: string }>(`/onboardings/${o2.id}/cases`, { code: 'TC-01', title: 'Retrait' });
  await back(`/onboardings/${o2.id}/advance`, {});
  await call(`${B}/onboardings/${o2.id}/cases/${c2.id}`, { method: 'PATCH', headers: S, body: JSON.stringify({ status: 'PASSED', evidence: 'trace-gab' }) });
  await back(`/onboardings/${o2.id}/advance`, {});
  await back(`/onboardings/${o2.id}/sign`, { party: 'BANK' });

  // Contenus publiés : communiqué important, enquête, document de bibliothèque.
  const com = await back<{ id: string }>('/contents', { kind: 'COMMUNIQUE', title: `Maintenance programmée ${run}`, body: 'Interruption samedi de 2 h à 4 h.', important: true });
  await back(`/contents/${com.id}/publish`, {});
  const survey = await back<{ id: string }>('/contents', { kind: 'ENQUETE', title: `Satisfaction ${run}`, questions: [{ id: 'note', label: 'Votre note', type: 'choice', options: ['1', '2', '3', '4', '5'] }, { id: 'avis', label: 'Votre avis', type: 'text' }] });
  await back(`/contents/${survey.id}/publish`, {});
  const doc = await back<{ id: string }>('/contents', { kind: 'DOCUMENT', title: `Guide des litiges ${run}`, category: 'Procédures' });
  await back(`/contents/${doc.id}/file`, { name: 'guide-litiges.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-1.4 guide').toString('base64') });
  await back(`/contents/${doc.id}/publish`, {});

  await keycloakUsers();
  writeFileSync(new URL('./.seed.json', import.meta.url), JSON.stringify({ run, apiName: `Services cartes ${run}`, freeApiName: `Affiliation ${run}`, acceptanceId: o.id, password: PASSWORD, requestSubject: `Relever le plafond ${run}`, arbitrationId: d.id, smtSignId: o2.id, gabName: `GAB ${run}`, requestId: req.id, communique: `Maintenance programmée ${run}`, survey: `Satisfaction ${run}`, doc: `Guide des litiges ${run}` }));
}
