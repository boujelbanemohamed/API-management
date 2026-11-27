import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import http from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { FixedClock } from '../src/common/clock';
import { InMemoryGatewayAdmin } from '../src/gateway/gateway-admin';
import { KeycloakTokenVerifier } from '../src/auth/token-verifier';
import { FakeScanner, InMemoryFileStore } from '../src/files/storage';
import { InMemoryDirectory } from '../src/users/users.module';
import { computeLines, settle } from '../src/billing/billing-rules';
import { sanitize } from '../src/assistant/assistant.module';
import { TEST_CONFIG, testDatabase, testRightsStore } from './fixtures';

describe('Lot 5b — facturation, identifiants, cahiers de tests, assistant, supervision', () => {
  let app: INestApplication;
  let api: ReturnType<typeof request>;
  let key: KeyLike;
  const clock = new FixedClock('2026-12-05');
  const S = { Authorization: `Bearer ${TEST_CONFIG.adminApiToken}`, 'x-actor': 'smt' };
  const ids: Record<string, string> = {};
  const tok = async (claims: Record<string, unknown>) =>
    `Bearer ${await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(TEST_CONFIG.keycloak.issuerUrl).setIssuedAt().setExpirationTime('5m').sign(key)}`;
  const bank = async (code: string, ...roles: string[]) => ({ Authorization: await tok({ preferred_username: 'u', azp: 'portail', realm_access: { roles }, partner_code: code }) });
  const smt = async (...roles: string[]) => ({ Authorization: await tok({ preferred_username: 'agent', azp: 'console', realm_access: { roles } }) });
  const post = (url: string, body: object = {}) => api.post(url).set(S).send(body);

  // Faux serveur de modèle (API « chat completions ») pour vérifier ce qui lui est envoyé.
  let modelRequests: any[] = [];
  const model = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      modelRequests.push(JSON.parse(b));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'Ouvrez le litige depuis l’écran Transactions [1].' } }] }));
    });
  });

  beforeAll(async () => {
    process.env.DISABLE_JOBS = 'true';
    await new Promise<void>((r) => model.listen(0, r));
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256' }] });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ config: TEST_CONFIG, database: testDatabase(), clock, gatewayAdmin: new InMemoryGatewayAdmin(), rightsStore: testRightsStore(), tokenVerifier: new KeycloakTokenVerifier(TEST_CONFIG.keycloak.issuerUrl, '', jwks), fileStore: new InMemoryFileStore(), virusScanner: new FakeScanner(), userDirectory: new InMemoryDirectory() })],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    api = request(app.getHttpServer()) as any;
    for (const code of ['BNA', 'STB']) {
      ids[code] = (await post('/partners', { code, name: code }).expect(201)).body.id;
      await post(`/partners/${ids[code]}/activate`).expect(200);
    }
    const prov = await post('/providers', { name: 'P1', baseUrl: 'https://p1.interne', sandboxBaseUrl: 'http://sim' }).expect(201);
    ids.api = (await post('/apis', { name: 'Transactions', slug: 'tx-v1', publicPath: '/tx/v1', upstreamPath: '/tx', providerId: prov.body.id, description: 'Consultation des transactions et ouverture de litiges' }).expect(201)).body.id;
    await post(`/apis/${ids.api}/status`, { status: 'PUBLISHED' }).expect(201);
    ids.plan = (await post('/plans', { name: 'Pro', dailyQuota: 1000, rateLimitPerSecond: 10, monthlyFee: 50_000, pricePerCall: 10 }).expect(201)).body.id;
  });
  afterAll(async () => {
    model.close();
    await app.close();
  });

  describe('Facturation globale', () => {
    beforeAll(async () => {
      clock.set('2026-11-02');
      const sub = await post('/subscriptions', { partnerId: ids.BNA, apiId: ids.api, planId: ids.plan, startDate: '2026-11-02', endDate: '2027-11-01' }).expect(201);
      await post(`/subscriptions/${sub.body.id}/validate`).expect(200);
      // 3 appels facturables (200) et 1 erreur (500) en novembre.
      const entry = (id: string, status: number) => ({ route_id: 'tx-v1', consumer: { username: 'bna' }, latency: 10, start_time: Date.parse('2026-11-15T09:00:00Z'), request: { headers: { 'x-request-id': id } }, response: { status } });
      await api.post('/internal/usage').set({ Authorization: `Bearer ${TEST_CONFIG.usageIngestToken}` }).send([entry('a', 200), entry('b', 200), entry('c', 200), entry('d', 500)]).expect(200);
      // Litige arbitré en novembre, perdu par la BNA (émetteur), frais 40 000 millimes.
      const d = await post('/disputes', { issuerId: ids.BNA, acquirerId: ids.STB, transactionRef: 'ARB1', maskedPan: '412345******2345', transactionDate: '2026-10-20', transactionAmount: 90000, reasonCode: '4853' }).expect(201);
      for (const a of [{ action: 'chargeback', party: 'ISSUER' }, { action: 'second-presentment', party: 'ACQUIRER' }, { action: 'second-chargeback', party: 'ISSUER', documentRef: 'nouveau' }, { action: 'arbitration-request', party: 'ACQUIRER' }]) await post(`/disputes/${d.body.id}/actions`, a).expect(200);
      clock.set('2026-11-28');
      await post(`/disputes/${d.body.id}/decision`, { winner: 'ACQUIRER', fees: 40_000 }).expect(200);
      clock.set('2026-12-05');
    });

    it('règles : prorata absent, appels × prix, frais au perdant ; statut après paiement', () => {
      const lines = computeLines('2026-11', [{ id: 's', apiId: 'a', apiName: 'X', apiSlug: 'x', planName: 'P', monthlyFee: 100, pricePerCall: 2, startDate: '2026-11-30', endDate: null }], { x: 5 }, [{ ref: 'L', fees: 7 }, { ref: 'Z', fees: 0 }]);
      expect(lines.map((l) => l.amount)).toEqual([100, 10, 7]);
      expect(settle(100, 0).status).toBe('ISSUED');
      expect(settle(100, 40)).toEqual({ status: 'PARTIAL', balance: 60, overpaid: 0 });
      expect(settle(100, 120)).toEqual({ status: 'PAID', balance: 0, overpaid: 20 });
    });

    it('émission : refusée pour le mois en cours ; relevé de novembre complet ; pas de doublon', async () => {
      expect((await post('/billing/statements/generate', { period: '2026-12' }).expect(409)).body.code).toBe('PERIOD_NOT_CLOSED');
      const gen = await post('/billing/statements/generate', { period: '2026-11' }).expect(200);
      expect(gen.body).toHaveLength(1);
      const st = gen.body[0];
      ids.statement = st.id;
      expect(st).toMatchObject({ partnerId: ids.BNA, period: '2026-11', total: 50_000 + 30 + 40_000, status: 'ISSUED', dueDate: '2027-01-04' });
      expect(st.lines.map((l: any) => l.kind)).toEqual(['SUBSCRIPTION', 'USAGE', 'ARBITRATION']);
      expect(st.lines[1]).toMatchObject({ quantity: 3, unitPrice: 10 });
      expect((await post('/billing/statements/generate', { period: '2026-11' }).expect(200)).body).toHaveLength(0);
    });

    it('portail : la banque voit son relevé et une notification ; l’autre banque non ; droits du rôle', async () => {
      const h = await bank('BNA', 'banque-facturation');
      const list = (await api.get('/portal/statements').set(h).expect(200)).body;
      expect(list).toHaveLength(1);
      await api.get(`/portal/statements/${ids.statement}`).set(h).expect(200);
      await api.get(`/portal/statements/${ids.statement}`).set(await bank('STB', 'banque-facturation')).expect(404);
      await api.get('/portal/statements').set(await bank('BNA', 'banque-gestionnaire-litiges')).expect(403);
      expect((await api.get('/portal/notifications').set(h)).body.some((n: any) => n.title === 'Nouveau relevé')).toBe(true);
    });

    it('rapprochement : paiement partiel, doublon refusé, paiement non affecté puis affecté, retard', async () => {
      await post('/billing/payments', { partnerId: ids.BNA, statementId: ids.statement, amount: 50_000, reference: 'VIR-001', receivedOn: '2026-12-10' }).expect(201);
      expect((await api.get(`/billing/statements/${ids.statement}`).set(S)).body).toMatchObject({ status: 'PARTIAL', paid: 50_000, balance: 40_030 });
      expect((await post('/billing/payments', { partnerId: ids.BNA, statementId: ids.statement, amount: 1, reference: 'VIR-001', receivedOn: '2026-12-10' }).expect(409)).body.code).toBe('PAYMENT_DUPLICATE');
      expect((await post('/billing/payments', { partnerId: ids.STB, statementId: ids.statement, amount: 1, reference: 'X', receivedOn: '2026-12-10' }).expect(409)).body.code).toBe('STATEMENT_MISMATCH');
      const loose = await post('/billing/payments', { partnerId: ids.BNA, amount: 40_030, reference: 'VIR-002', receivedOn: '2026-12-12' }).expect(201);
      clock.set('2027-01-10');
      let rec = (await api.get('/billing/reconciliation?period=2026-11').set(S)).body;
      expect(rec.statements[0]).toMatchObject({ bank: 'BNA', status: 'PARTIAL', overdue: true });
      expect(rec.unassigned.map((p: any) => p.reference)).toEqual(['VIR-002']);
      await api.post(`/billing/payments/${loose.body.id}/assign`).set(S).send({ statementId: ids.statement }).expect(200);
      rec = (await api.get('/billing/reconciliation?period=2026-11').set(S)).body;
      expect(rec.statements[0]).toMatchObject({ status: 'PAID', balance: 0, overdue: false });
      expect(rec.unassigned).toHaveLength(0);
      clock.set('2026-12-05');
    });

    it('droits : la facturation est réservée à la section Finance', async () => {
      await api.post('/billing/statements/generate').set(await smt('console-agent-support')).send({ period: '2026-11' }).expect(403);
      await api.get('/billing/reconciliation').set(await smt('console-facturation')).expect(200);
    });
  });

  describe('Identifiants et sandbox', () => {
    it('le développeur voit ses accès et génère une clé affichée une seule fois', async () => {
      const dev = await bank('BNA', 'banque-developpeur');
      const before = (await api.get('/portal/credentials').set(dev).expect(200)).body;
      expect(before.production[0]).toMatchObject({ api: 'Transactions', path: '/tx/v1', status: 'ACTIVE' });
      const k = await api.post('/portal/credentials/api-key').set(dev).expect(200);
      expect(k.body.apiKey).toMatch(/^ak_bna_/);
      const after = (await api.get('/portal/credentials').set(dev)).body;
      expect(after.apiKeyFingerprint).toBe(k.body.fingerprint.slice(0, 12));
      expect(JSON.stringify(after)).not.toContain(k.body.apiKey);
      await api.post('/portal/credentials/api-key').set(await bank('BNA', 'banque-lecture')).expect(403);
    });
  });

  describe('Cahiers de tests', () => {
    it('le cahier type est recopié à l’entrée en sandbox ; codes en double refusés', async () => {
      expect((await api.put(`/test-books/${ids.api}`).set(S).send({ cases: [{ code: 'T1', title: 'a', mandatory: true }, { code: 'T1', title: 'b', mandatory: false }] }).expect(409)).body.code).toBe('DUPLICATE_CASE');
      const book = await api.put(`/test-books/${ids.api}`).set(S).send({ cases: [{ code: 'TX-01', title: 'Recherche par date', mandatory: true }, { code: 'TX-02', title: 'Export', mandatory: false }] }).expect(200);
      expect(book.body.version).toBe(1);
      const o = await post('/onboardings', { partnerId: ids.STB, apiId: ids.api, planId: ids.plan }).expect(201);
      await post(`/onboardings/${o.body.id}/advance`).expect(200);
      await post(`/onboardings/${o.body.id}/contract`, { contractReference: 'C', validatedBy: 'j' }).expect(200);
      await post(`/onboardings/${o.body.id}/advance`).expect(200);
      const cases = (await api.get(`/onboardings/${o.body.id}`).set(S)).body.testCases;
      expect(cases.map((c: any) => [c.code, c.mandatory, c.status])).toEqual([['TX-01', true, 'TODO'], ['TX-02', false, 'TODO']]);
      await api.put(`/test-books/${ids.api}`).set(await smt('console-agent-litiges')).send({ cases: [] }).expect(403);
    });
  });

  describe('Assistant', () => {
    beforeAll(async () => {
      const doc = await post('/contents', { kind: 'DOCUMENT', title: 'Procédure de litige', category: 'Procédures', body: 'Pour ouvrir un litige, utilisez l’écran Transactions puis Contester. Le chargeback doit être émis sous 120 jours.' }).expect(201);
      await post(`/contents/${doc.body.id}/file`, { name: 'p.pdf', mime: 'application/pdf', content: Buffer.from('%PDF').toString('base64') }).expect(201);
      await post(`/contents/${doc.body.id}/publish`).expect(200);
    });

    it('sans modèle : extraits sourcés (bibliothèque et catalogue)', async () => {
      delete process.env.ASSISTANT_URL;
      const r = await api.post('/portal/assistant').set(await bank('BNA', 'banque-lecture')).send({ question: 'Comment ouvrir un litige sur une transaction ?' }).expect(201);
      expect(r.body.mode).toBe('extraits');
      expect(r.body.sources.map((s: any) => s.kind)).toEqual(expect.arrayContaining(['Bibliothèque', 'Catalogue']));
      expect(r.body.sources[0].excerpt).toContain('120 jours');
    });

    it('avec modèle : il ne reçoit jamais le numéro de carte ; la réponse cite les sources', async () => {
      process.env.ASSISTANT_URL = `http://127.0.0.1:${(model.address() as any).port}`;
      modelRequests = [];
      const r = await api.post('/portal/assistant').set(await bank('BNA', 'banque-lecture')).send({ question: 'Litige pour la carte 4123 4567 8901 2345 : quelle procédure ?' }).expect(201);
      expect(r.body).toMatchObject({ mode: 'modele', answer: 'Ouvrez le litige depuis l’écran Transactions [1].' });
      const sent = JSON.stringify(modelRequests[0]);
      expect(sent).not.toMatch(/4123\s?4567/);
      expect(sent).toContain('[numéro retiré]');
      expect(sanitize('carte 4123456789012345')).toBe('carte [numéro retiré]');
      delete process.env.ASSISTANT_URL;
    });

    it('limite de 20 questions par heure et par utilisateur', async () => {
      const h = { Authorization: await tok({ preferred_username: 'bavard', azp: 'portail', realm_access: { roles: ['banque-lecture'] }, partner_code: 'STB' }) };
      for (let i = 0; i < 20; i++) await api.post('/portal/assistant').set(h).send({ question: 'litige procédure' }).expect(201);
      expect((await api.post('/portal/assistant').set(h).send({ question: 'litige procédure' }).expect(429)).body.code).toBe('ASSISTANT_LIMIT');
    });
  });

  describe('Supervision', () => {
    it('état des dépendances et de la messagerie, réservé à l’administration', async () => {
      const r = (await api.get('/console/supervision').set(await smt('console-admin')).expect(200)).body;
      expect(r.checks.find((c: any) => c.name.startsWith('Base de données')).status).toBe('ok');
      expect(r.checks.find((c: any) => c.name.startsWith('Antivirus')).status).toBe('ok');
      expect(r.outbox).toHaveProperty('PENDING');
      expect(r.settings).toMatchObject({ onboardingEnforced: false, broker: 'mémoire (développement)' });
      await api.get('/console/supervision').set(await smt('console-agent-support')).expect(403);
    });
  });
});
