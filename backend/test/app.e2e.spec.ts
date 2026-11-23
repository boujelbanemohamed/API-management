import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { FixedClock } from '../src/common/clock';
import { InMemoryGatewayAdmin } from '../src/gateway/gateway-admin';
import { InMemoryRightsStore } from '../src/gateway/rights-store';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';
import { TEST_CONFIG } from './fixtures';

describe('Plateforme API — parcours complet (base en mémoire, passerelle simulée)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const clock = new FixedClock('2026-11-23');
  const gateway = new InMemoryGatewayAdmin();
  const rights = new InMemoryRightsStore();
  const ADMIN = { Authorization: `Bearer ${TEST_CONFIG.adminApiToken}`, 'x-actor': 'mohamed' };

  const ids: Record<string, string> = {};
  const post = (url: string, body: object = {}) => http.post(url).set(ADMIN).send(body);
  const get = (url: string) => http.get(url).set(ADMIN);

  beforeAll(async () => {
    process.env.DISABLE_JOBS = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: TEST_CONFIG,
          database: { type: 'sqljs', synchronize: true, autoSave: false },
          clock,
          gatewayAdmin: gateway,
          rightsStore: rights,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    http = request(app.getHttpServer()) as any;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuse les appels sans jeton d’administration', async () => {
    await http.get('/partners').expect(401);
    await http.get('/partners').set({ Authorization: 'Bearer faux' }).expect(401);
    await http.get('/health').expect(200, { status: 'ok' });
  });

  it('crée le catalogue : fournisseur, service, plans', async () => {
    const prov = await post('/providers', {
      name: 'Plateforme 1',
      baseUrl: 'https://plateforme1.interne:8443',
      sandboxBaseUrl: 'http://simulateur-p1:8080',
    }).expect(201);
    ids.provider = prov.body.id;

    const apiRes = await post('/apis', {
      name: 'Consultation des transactions',
      slug: 'transactions-v1',
      publicPath: '/transactions/v1',
      upstreamPath: '/api/transactions',
      providerId: ids.provider,
    }).expect(201);
    ids.api = apiRes.body.id;
    expect(apiRes.body.status).toBe('DRAFT');

    const std = await post('/plans', { name: 'Standard', dailyQuota: 10000, rateLimitPerSecond: 20 }).expect(201);
    const prem = await post('/plans', { name: 'Premium', dailyQuota: 100000, rateLimitPerSecond: 100 }).expect(201);
    ids.standard = std.body.id;
    ids.premium = prem.body.id;
  });

  it('valide les entrées et renvoie des erreurs lisibles', async () => {
    const bad = await post('/apis', { name: 'X', slug: 'Invalid Slug', publicPath: 'sans-slash', upstreamPath: '/a', providerId: 'nope' }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    await post('/partners', { code: 'BNA', name: 'Banque', allowedIps: ['999.1.1.1'] }).expect(400);
    await post('/partners', { code: 'BNA', name: 'Banque', champInconnu: 1 }).expect(400);
  });

  it('inscrit un partenaire et lui génère une clé d’API affichée une seule fois', async () => {
    const res = await post('/partners', {
      code: 'bna',
      name: 'Banque Nationale Agricole',
      technicalContactEmail: 'it@bna.tn',
      allowedIps: ['196.203.10.0/28'],
    }).expect(201);
    ids.partner = res.body.id;
    expect(res.body).toMatchObject({ code: 'BNA', status: 'PENDING', hasApiKey: false });
    expect(res.body.apiKeyHash).toBeUndefined();
    expect(gateway.consumers.has('bna')).toBe(true);

    await post('/partners', { code: 'BNA', name: 'Doublon' }).expect(409);

    const key = await post(`/partners/${ids.partner}/api-key`).expect(201);
    expect(key.body.apiKey).toMatch(/^ak_bna_/);
    expect(gateway.credentials.get('bna/api-key')).toEqual({ 'key-auth': { key: key.body.apiKey } });
    const after = await get(`/partners/${ids.partner}`).expect(200);
    expect(after.body.hasApiKey).toBe(true);
  });

  it('refuse un abonnement à un service non publié', async () => {
    const res = await post('/subscriptions', { partnerId: ids.partner, apiId: ids.api, planId: ids.standard }).expect(409);
    expect(res.body.code).toBe('API_NOT_SUBSCRIBABLE');
    await post(`/apis/${ids.api}/status`, { status: 'PUBLISHED' }).expect(201);
    expect(gateway.routes.has('transactions-v1')).toBe(true);
  });

  it('crée un abonnement en attente, sans accès tant qu’il n’est pas validé', async () => {
    const res = await post('/subscriptions', {
      partnerId: ids.partner,
      apiId: ids.api,
      planId: ids.standard,
      endDate: '2027-11-22',
      contractReference: 'CONV-2026-014',
    }).expect(201);
    ids.sub = res.body.id;
    expect(res.body).toMatchObject({ status: 'PENDING', startDate: '2026-11-23', environment: 'PRODUCTION' });
    expect(await rights.get('sub:bna:transactions-v1')).toMatchObject({ status: 'inactive', reason: 'partner_inactive' });

    const dup = await post('/subscriptions', { partnerId: ids.partner, apiId: ids.api, planId: ids.premium }).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_SUBSCRIPTION');
  });

  it('ouvre l’accès quand le partenaire est activé et l’abonnement validé', async () => {
    await post(`/partners/${ids.partner}/activate`).expect(200);
    expect(await rights.get('sub:bna:transactions-v1')).toMatchObject({ status: 'inactive', reason: 'pending' });
    await post(`/subscriptions/${ids.sub}/validate`).expect(200);
    expect(await rights.get('sub:bna:transactions-v1')).toMatchObject({
      status: 'active',
      daily_quota: 10000,
      rate_per_second: 20,
      end: '2027-11-22',
    });
    await post(`/subscriptions/${ids.sub}/validate`).expect(409);
  });

  it('suspend et réactive avec effet immédiat sur la passerelle', async () => {
    await post(`/subscriptions/${ids.sub}/suspend`, { reason: 'Impayé' }).expect(200);
    expect(await rights.get('sub:bna:transactions-v1')).toMatchObject({ status: 'inactive', reason: 'suspended' });
    await post(`/subscriptions/${ids.sub}/reactivate`).expect(200);
    await post(`/partners/${ids.partner}/suspend`).expect(200);
    expect((await rights.get('sub:bna:transactions-v1'))!.status).toBe('inactive');
    await post(`/partners/${ids.partner}/activate`).expect(200);
    expect((await rights.get('sub:bna:transactions-v1'))!.status).toBe('active');
  });

  it('ajuste le quota et programme un changement de plan au 1er du mois suivant', async () => {
    await http.patch(`/subscriptions/${ids.sub}/quota`).set(ADMIN).send({ customDailyQuota: 500 }).expect(200);
    expect((await rights.get('sub:bna:transactions-v1'))!.daily_quota).toBe(500);

    const res = await post(`/subscriptions/${ids.sub}/change-plan`, { planId: ids.premium, effective: 'NEXT_MONTH' }).expect(200);
    expect(res.body).toMatchObject({ planId: ids.standard, scheduledPlanId: ids.premium, scheduledPlanFrom: '2026-12-01' });
    expect((await rights.get('sub:bna:transactions-v1'))!.rate_per_second).toBe(20);

    clock.set('2026-12-01');
    const maintenance = await app.get(SubscriptionsService).runDailyMaintenance();
    expect(maintenance).toEqual({ expired: 0, plansApplied: 1 });
    expect((await rights.get('sub:bna:transactions-v1'))!.rate_per_second).toBe(100);
    const sub = await get(`/subscriptions/${ids.sub}`).expect(200);
    expect(sub.body).toMatchObject({ planId: ids.premium, scheduledPlanId: null });
  });

  it('expire à échéance puis renouvelle', async () => {
    clock.set('2027-11-23');
    expect(await app.get(SubscriptionsService).runDailyMaintenance()).toEqual({ expired: 1, plansApplied: 0 });
    expect(await rights.get('sub:bna:transactions-v1')).toMatchObject({ status: 'inactive', reason: 'expired' });

    await post(`/subscriptions/${ids.sub}/renew`, { endDate: '2027-01-01' }).expect(409);
    const renewed = await post(`/subscriptions/${ids.sub}/renew`, { endDate: '2028-11-22' }).expect(200);
    expect(renewed.body.status).toBe('ACTIVE');
    expect((await rights.get('sub:bna:transactions-v1'))!.status).toBe('active');
  });

  it('compte l’usage une seule fois par requête et calcule le facturable', async () => {
    const entry = (id: string, status: number, consumer = 'bna') => ({
      route_id: 'transactions-v1',
      consumer: { username: consumer },
      latency: 42.7,
      start_time: Date.parse('2027-11-23T09:00:00Z'),
      request: { headers: { 'x-request-id': id } },
      response: { status },
    });
    const batch = [entry('r1', 200), entry('r2', 200), entry('r3', 500), entry('r4', 429), entry('r1', 200), { route_id: 'transactions-v1', response: { status: 401 } }];

    await http.post('/internal/usage').send(batch).expect(401);
    await http.post('/internal/usage').set(ADMIN).send(batch).expect(401); // le jeton admin ne suffit pas
    const ingest = await http.post('/internal/usage').set({ Authorization: `Bearer ${TEST_CONFIG.usageIngestToken}` }).send(batch).expect(200);
    expect(ingest.body).toEqual({ received: 6, inserted: 4, ignored: 2 });
    const replay = await http.post('/internal/usage').set({ Authorization: `Bearer ${TEST_CONFIG.usageIngestToken}` }).send(batch).expect(200);
    expect(replay.body.inserted).toBe(0);

    const summary = await get('/usage/summary?from=2027-11-01&to=2027-11-30').expect(200);
    expect(summary.body).toEqual([{ partnerCode: 'BNA', apiSlug: 'transactions-v1', calls: 4, billable: 2, errors: 2, avgLatencyMs: 43 }]);
    const daily = await get('/usage/daily?from=2027-11-01&to=2027-11-30&partner=bna').expect(200);
    expect(daily.body).toEqual([{ day: '2027-11-23', calls: 4, billable: 2 }]);
    await get('/usage/summary?from=2027-11-30&to=2027-11-01').expect(400);
  });

  it('résilie le partenaire : abonnements résiliés, consumer et droits retirés', async () => {
    const res = await post(`/partners/${ids.partner}/terminate`, { reason: 'Fin de convention' }).expect(200);
    expect(res.body).toMatchObject({ status: 'TERMINATED', hasApiKey: false });
    const sub = await get(`/subscriptions/${ids.sub}`).expect(200);
    expect(sub.body.status).toBe('TERMINATED');
    expect(gateway.consumers.has('bna')).toBe(false);
    expect(gateway.credentials.size).toBe(0);
    expect(rights.data.size).toBe(0);
    await post(`/partners/${ids.partner}/api-key`).expect(409);
  });

  it('trace chaque action dans le journal d’audit', async () => {
    const res = await get(`/audit?objectType=subscription&objectId=${ids.sub}`).expect(200);
    const actions = res.body.map((e: any) => e.action).reverse();
    expect(actions).toEqual([
      'subscription.created',
      'subscription.validate',
      'subscription.suspend',
      'subscription.reactivate',
      'subscription.quota_changed',
      'subscription.changePlan',
      'subscription.plan_applied',
      'subscription.expired',
      'subscription.renew',
    ]);
    expect(res.body.find((e: any) => e.action === 'subscription.suspend')).toMatchObject({ actor: 'mohamed', details: { reason: 'Impayé' } });
  });

  it('expose l’état de la synchronisation passerelle', async () => {
    const res = await get('/gateway/status').expect(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
