import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { FixedClock } from '../src/common/clock';
import { InMemoryGatewayAdmin } from '../src/gateway/gateway-admin';
import { InMemoryRightsStore } from '../src/gateway/rights-store';
import { TEST_CONFIG } from './fixtures';

describe('Demandes, mises en service et litiges (règle de production appliquée)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const clock = new FixedClock('2026-11-23');
  const as = (actor: string) => ({ Authorization: `Bearer ${TEST_CONFIG.adminApiToken}`, 'x-actor': actor });
  const post = (url: string, body: object = {}, actor = 'amel') => http.post(url).set(as(actor)).send(body);
  const patch = (url: string, body: object, actor = 'amel') => http.patch(url).set(as(actor)).send(body);
  const get = (url: string) => http.get(url).set(as('amel'));
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DISABLE_JOBS = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: { ...TEST_CONFIG, onboarding: { enforceForProduction: true } },
          database: { type: 'sqljs', synchronize: true, autoSave: false },
          clock,
          gatewayAdmin: new InMemoryGatewayAdmin(),
          rightsStore: new InMemoryRightsStore(),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    http = request(app.getHttpServer()) as any;

    const prov = await post('/providers', { name: 'SVIP', baseUrl: 'https://svip.interne', sandboxBaseUrl: 'http://sim-svip' }).expect(201);
    const api = await post('/apis', { name: 'Services cartes', slug: 'cartes-v1', publicPath: '/cartes/v1', upstreamPath: '/cards', providerId: prov.body.id }).expect(201);
    ids.api = api.body.id;
    await post(`/apis/${ids.api}/status`, { status: 'PUBLISHED' }).expect(201);
    ids.plan = (await post('/plans', { name: 'Standard', dailyQuota: 1000, rateLimitPerSecond: 10 }).expect(201)).body.id;
    for (const code of ['bna', 'stb']) {
      const p = await post('/partners', { code, name: code.toUpperCase() }).expect(201);
      ids[code] = p.body.id;
      await post(`/partners/${p.body.id}/activate`).expect(200);
    }
  });

  afterAll(() => app.close());

  it('santé : base, Valkey et APISIX joignables', async () => {
    const r = await http.get('/health/ready').expect(200);
    expect(r.body).toEqual({ status: 'ok', checks: { database: 'ok', valkey: 'ok', apisix: 'ok' } });
  });

  it('demande : délai en jours ouvrés, suspension et double validation', async () => {
    const r = await post('/requests', {
      partnerId: ids.bna,
      type: 'OPERATION',
      subject: 'Lever une opposition',
      sensitive: true,
      context: { carte: '412345******2345' },
    }).expect(201);
    expect(r.body).toMatchObject({ team: 'OPERATIONS', slaDays: 2, status: 'NEW' });

    const full = await post('/requests', { partnerId: ids.bna, type: 'SUPPORT', subject: 'x', context: { carte: '4123456789012345' } }).expect(409);
    expect(full.body.code).toBe('FULL_PAN_FORBIDDEN');

    const id = r.body.id;
    await post(`/requests/${id}/assign`, { assignee: 'amel' }).expect(200);
    await post(`/requests/${id}/wait`, { on: 'BANK' }).expect(200);
    clock.set('2026-11-25');
    const resumed = await post(`/requests/${id}/resume`).expect(200);
    expect(resumed.body.suspendedWorkingDays).toBe(2);
    expect(resumed.body.dueDate).toBe('2026-11-27');

    const prepared = await post(`/requests/${id}/complete`).expect(200);
    expect(prepared.body.status).toBe('AWAITING_VALIDATION');
    const same = await post(`/requests/${id}/validate`).expect(409);
    expect(same.body.code).toBe('SAME_VALIDATOR');
    const done = await post(`/requests/${id}/validate`, {}, 'karim').expect(200);
    expect(done.body).toMatchObject({ status: 'DONE', sla: 'MET', validatedBy: 'karim' });
    clock.set('2026-11-23');
  });

  it('jours fériés et engagements paramétrables', async () => {
    await post('/holidays', { date: '2026-11-24', label: 'Fête variable (test)' }).expect(201);
    await http.put('/commitments/API_ACCESS').set(as('amel')).send({ team: 'INTEGRATION', slaDays: 1 }).expect(200);
    const r = await post('/requests', { partnerId: ids.bna, type: 'API_ACCESS', subject: 'Accès' }).expect(201);
    const view = await get(`/requests/${r.body.id}`).expect(200);
    expect(view.body.dueDate).toBe('2026-11-25'); // le 24 est férié
  });

  it('mise en service : production refusée sans PV doublement signé, puis abonnement créé automatiquement', async () => {
    const refused = await post('/subscriptions', { partnerId: ids.bna, apiId: ids.api, planId: ids.plan }).expect(409);
    expect(refused.body.code).toBe('ONBOARDING_REQUIRED');

    const o = (await post('/onboardings', { partnerId: ids.bna, apiId: ids.api, planId: ids.plan }).expect(201)).body;
    const adv = () => post(`/onboardings/${o.id}/advance`);
    await adv().expect(200); // → CONTRACT
    expect((await adv().expect(409)).body.code).toBe('CONTRACT_MISSING');
    await post(`/onboardings/${o.id}/contract`, { contractReference: 'CTR-2026-14', validatedBy: 'juriste' }).expect(200);
    await adv().expect(200); // → SANDBOX (abonnement sandbox ouvert)
    const sandbox = await get(`/subscriptions?partnerId=${ids.bna}&environment=SANDBOX`).expect(200);
    expect(sandbox.body[0]).toMatchObject({ status: 'ACTIVE' });

    await post(`/onboardings/${o.id}/test-mode`, { testMode: 'JOINT' }).expect(200);
    const c = (await post(`/onboardings/${o.id}/cases`, { code: 'TC-01', title: 'Opposition carte' }).expect(201)).body;
    await adv().expect(200); // → TESTS
    expect((await adv().expect(409)).body.code).toBe('TESTS_INCOMPLETE');
    await patch(`/onboardings/${o.id}/cases/${c.id}`, { status: 'PASSED', evidence: 'trace-8f2' }).expect(200);
    expect((await adv().expect(409)).body.code).toBe('JOINT_SESSION_MISSING');
    await post(`/onboardings/${o.id}/joint-sessions`).expect(200);
    await adv().expect(200); // → ACCEPTANCE

    await post(`/onboardings/${o.id}/sign`, { party: 'BANK' }, 'rssi-bna').expect(200);
    expect((await adv().expect(409)).body.code).toBe('ACCEPTANCE_NOT_SIGNED');
    await post(`/onboardings/${o.id}/sign`, { party: 'SMT' }, 'dir-smt').expect(200);
    const live = await adv().expect(200);
    expect(live.body.step).toBe('PRODUCTION');
    const prod = await get(`/subscriptions/${live.body.productionSubscriptionId}`).expect(200);
    expect(prod.body).toMatchObject({ environment: 'PRODUCTION', status: 'ACTIVE', contractReference: 'CTR-2026-14' });
  });

  it('litige : chargeback partiel, représentation, second chargeback, arbitrage SMT', async () => {
    const bad = await post('/disputes', {
      issuerId: ids.bna, acquirerId: ids.stb, transactionRef: 'T1', maskedPan: '4123456789012345',
      transactionDate: '2026-10-01', transactionAmount: 100000, reasonCode: '4853',
    }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');

    const d = (await post('/disputes', {
      issuerId: ids.bna, acquirerId: ids.stb, transactionRef: 'T1', maskedPan: '412345******2345',
      transactionDate: '2026-10-01', transactionAmount: 100000, reasonCode: '4853',
    }).expect(201)).body;
    const act = (body: object, actor = 'amel') => post(`/disputes/${d.id}/actions`, body, actor);

    const cb = await act({ action: 'chargeback', party: 'ISSUER', amount: 40000 }).expect(200);
    expect(cb.body.message).toEqual({ mti: '1442', functionCode: '453' });
    expect((await act({ action: 'accept', party: 'ISSUER' }).expect(409)).body.code).toBe('NOT_YOUR_TURN');
    await act({ action: 'second-presentment', party: 'ACQUIRER', documentRef: 'doc-1' }).expect(200);
    expect((await act({ action: 'second-chargeback', party: 'ISSUER' }).expect(409)).body.code).toBe('NEW_DOCUMENT_REQUIRED');
    await act({ action: 'second-chargeback', party: 'ISSUER', documentRef: 'doc-2' }).expect(200);
    await act({ action: 'arbitration-request', party: 'ACQUIRER' }).expect(200);
    const dec = await post(`/disputes/${d.id}/decision`, { winner: 'ISSUER', fees: 50000 }, 'arbitre').expect(200);
    expect(dec.body).toMatchObject({ stage: 'CLOSED_DECIDED', winner: 'ISSUER', message: { mti: '1740' } });

    const full = await get(`/disputes/${d.id}`).expect(200);
    expect(full.body.events.map((e: any) => e.mti)).toEqual(['1442', '1240', '1442', null, '1740']);
    expect((await get(`/disputes?bankId=${ids.stb}`).expect(200)).body).toHaveLength(1);
  });
});
