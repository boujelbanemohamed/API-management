import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { FixedClock } from '../src/common/clock';
import { InMemoryGatewayAdmin } from '../src/gateway/gateway-admin';
import { InMemoryBus, TOPICS } from '../src/integration/message-bus';
import { OutboxRelay } from '../src/integration/integration.module';
import { TEST_CONFIG, testDatabase, testRightsStore } from './fixtures';

describe('Lot 4a — couche d’intégration : outbox, bus, réception idempotente', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let relay: OutboxRelay;
  const bus = new InMemoryBus();
  const S = { Authorization: `Bearer ${TEST_CONFIG.adminApiToken}`, 'x-actor': 'qa' };
  const post = (url: string, body: object = {}) => http.post(url).set(S).send(body);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DISABLE_JOBS = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ config: TEST_CONFIG, database: testDatabase(), clock: new FixedClock('2026-11-23'), gatewayAdmin: new InMemoryGatewayAdmin(), rightsStore: testRightsStore(), messageBus: bus })],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    http = request(app.getHttpServer()) as any;
    relay = app.get(OutboxRelay);
    for (const code of ['BNA', 'STB']) ids[code] = (await post('/partners', { code, name: code }).expect(201)).body.id;
  });
  afterAll(() => app.close());

  const outgoing = () => bus.published.filter((m) => m.topic === TOPICS.chargebackOutgoing);

  it('litige : l’action et son message ISO sont enregistrés ensemble, puis publiés par le relais', async () => {
    const d = await post('/disputes', { issuerId: ids.BNA, acquirerId: ids.STB, transactionRef: 'TX1', maskedPan: '412345******2345', transactionDate: '2026-11-01', transactionAmount: 100000, reasonCode: '4853' }).expect(201);
    ids.dispute = d.body.id;
    await post(`/disputes/${d.body.id}/actions`, { action: 'chargeback', party: 'ISSUER', amount: 30000 }).expect(200);
    expect(outgoing()).toHaveLength(0); // pas encore publié : il est dans l'outbox
    expect(await relay.flush()).toBe(1);
    expect(outgoing()[0].payload).toMatchObject({ mti: '1442', functionCode: '453', amount: 30000, maskedPan: '412345******2345', issuerCode: 'BNA', acquirerCode: 'STB', transactionRef: 'TX1' });
    const ev = (await http.get(`/disputes/${d.body.id}`).set(S).expect(200)).body.events[0];
    expect(ev).toMatchObject({ mti: '1442', deliveryStatus: 'PENDING' });
    ids.event = ev.id;
    expect(await relay.flush()).toBe(0); // déjà publié
  });

  it('courtier en panne : le message reste dans l’outbox et repart quand le courtier revient', async () => {
    await post(`/disputes/${ids.dispute}/actions`, { action: 'second-presentment', party: 'ACQUIRER' }).expect(200);
    bus.failing = true;
    const now = Date.now();
    expect(await relay.flush(now)).toBe(0);
    const [stuck] = await relay.pending();
    expect(stuck).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(stuck.lastError).toContain('injoignable');
    expect(await relay.flush(now + 100)).toBe(0); // délai de reprise pas encore écoulé
    bus.failing = false;
    expect(await relay.flush(now + 5_000)).toBe(1);
    expect(outgoing().at(-1)!.payload).toMatchObject({ mti: '1240', functionCode: '205' });
  });

  it('retour de la plateforme : accusé appliqué une seule fois, même rejoué', async () => {
    await bus.publish(TOPICS.chargebackResult, { eventId: ids.event, status: 'ACKED', actionCode: '000' }, `${ids.event}:result`);
    let ev = (await http.get(`/disputes/${ids.dispute}`).set(S)).body.events[0];
    expect(ev).toMatchObject({ deliveryStatus: 'ACKED', actionCode: '000' });
    // Rejeu d'un message déjà traité avec un contenu différent : ignoré.
    await bus.publish(TOPICS.chargebackResult, { eventId: ids.event, status: 'REJECTED', actionCode: '909' }, `${ids.event}:result`);
    ev = (await http.get(`/disputes/${ids.dispute}`).set(S)).body.events[0];
    expect(ev.deliveryStatus).toBe('ACKED');
    const audit = (await http.get(`/audit?objectType=dispute&objectId=${ids.dispute}`).set(S)).body.filter((a: any) => a.action.startsWith('dispute.message.'));
    expect(audit).toHaveLength(1);
  });

  it('retour inconnu : message envoyé en rebut, sans effet', async () => {
    const before = bus.deadLetters.length;
    await bus.publish(TOPICS.chargebackResult, { eventId: '00000000-0000-0000-0000-000000000000', status: 'ACKED' }, 'inconnu:result');
    expect(bus.deadLetters.length).toBe(before + 1);
  });

  it('demande GAB : transmise au Cockpit automatiquement, clôturée par son retour', async () => {
    const r = await post('/requests', { partnerId: ids.BNA, type: 'OPERATION', subject: 'Débloquer GAB 0142', context: { service: 'gab', reference: 'GAB-0142' } }).expect(201);
    expect(r.body).toMatchObject({ status: 'IN_PROGRESS', assignee: 'SMT Cockpit', routedTo: 'COCKPIT' });
    await relay.flush();
    expect(bus.published.find((m) => m.topic === TOPICS.cockpitOrder)!.payload).toMatchObject({ requestId: r.body.id, partnerCode: 'BNA', service: 'GAB' });

    await bus.publish(TOPICS.cockpitEvent, { requestId: r.body.id, status: 'NEED_INFO', message: 'Préciser le terminal' }, 'cockpit:ev1');
    let v = (await http.get(`/requests/${r.body.id}`).set(S)).body;
    expect(v).toMatchObject({ status: 'WAITING_BANK', sla: 'PAUSED', externalMessage: 'Préciser le terminal' });
    await post(`/requests/${r.body.id}/resume`).expect(200);
    await bus.publish(TOPICS.cockpitEvent, { requestId: r.body.id, status: 'DONE', message: 'Opération exécutée' }, 'cockpit:ev2');
    v = (await http.get(`/requests/${r.body.id}`).set(S)).body;
    expect(v).toMatchObject({ status: 'DONE', sla: 'MET' });
    // Un retour tardif sur une demande close est ignoré.
    await bus.publish(TOPICS.cockpitEvent, { requestId: r.body.id, status: 'REJECTED' }, 'cockpit:ev3');
    expect((await http.get(`/requests/${r.body.id}`).set(S)).body.status).toBe('DONE');
  });

  it('opération sensible exécutée par le Cockpit : validée par un agent ; refus du Cockpit : demande rejetée avec motif', async () => {
    const s = await post('/requests', { partnerId: ids.BNA, type: 'OPERATION', subject: 'Plafond TPE', sensitive: true, context: { service: 'TPE' } }).expect(201);
    await bus.publish(TOPICS.cockpitEvent, { requestId: s.body.id, status: 'DONE' }, 'cockpit:ev4');
    expect((await http.get(`/requests/${s.body.id}`).set(S)).body).toMatchObject({ status: 'AWAITING_VALIDATION', preparedBy: 'SMT Cockpit' });
    await post(`/requests/${s.body.id}/validate`).expect(200);

    const x = await post('/requests', { partnerId: ids.BNA, type: 'OPERATION', subject: 'Affiliation', context: { service: 'AFFILIATION' } }).expect(201);
    await bus.publish(TOPICS.cockpitEvent, { requestId: x.body.id, status: 'REJECTED', message: 'Dossier incomplet' }, 'cockpit:ev5');
    expect((await http.get(`/requests/${x.body.id}`).set(S)).body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Dossier incomplet' });
  });

  it('Cockpit injoignable : la demande revient dans la file des agents, sans rejet', async () => {
    const r = await post('/requests', { partnerId: ids.BNA, type: 'OPERATION', subject: 'GAB hors ligne', context: { service: 'GAB' } }).expect(201);
    await bus.publish(TOPICS.cockpitEvent, { requestId: r.body.id, status: 'TRANSMISSION_FAILED', message: 'Transmission au Cockpit impossible' }, `${r.body.id}:transmission-failed`);
    expect((await http.get(`/requests/${r.body.id}`).set(S)).body).toMatchObject({ status: 'IN_PROGRESS', assignee: null, routedTo: null, externalMessage: 'Transmission au Cockpit impossible' });
    await post(`/requests/${r.body.id}/assign`, { assignee: 'amel' }).expect(200);
  });

  it('demande hors Cockpit (carte) : reste dans la file SMT, aucun ordre', async () => {
    const before = bus.published.length + (await relay.pending()).length;
    const r = await post('/requests', { partnerId: ids.BNA, type: 'OPERATION', subject: 'Opposition', context: { service: 'CARTE', reference: '412345******2345' } }).expect(201);
    expect(r.body).toMatchObject({ status: 'NEW', routedTo: null });
    await relay.flush();
    expect(bus.published.length + (await relay.pending()).length).toBe(before);
  });
});
