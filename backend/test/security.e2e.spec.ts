import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { FixedClock } from '../src/common/clock';
import { InMemoryGatewayAdmin } from '../src/gateway/gateway-admin';
import { KeycloakTokenVerifier } from '../src/auth/token-verifier';
import { TEST_CONFIG, testDatabase, testRightsStore } from './fixtures';

const ISSUER = TEST_CONFIG.keycloak.issuerUrl;

describe('Lot 2 — sécurité : rôles de la console et cloisonnement du portail', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let privateKey: KeyLike;
  const ids: Record<string, string> = {};
  const SERVICE = { Authorization: `Bearer ${TEST_CONFIG.adminApiToken}`, 'x-actor': 'init' };

  /** Jeton signé comme par Keycloak. */
  async function token(o: { user: string; client?: string; roles: string[]; bank?: string; iss?: string; exp?: string }) {
    const claims: Record<string, unknown> = { preferred_username: o.user, azp: o.client ?? 'console', realm_access: { roles: o.roles } };
    if (o.bank) claims.partner_code = o.bank;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(o.iss ?? ISSUER)
      .setSubject(o.user)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '5m')
      .sign(privateKey);
  }
  const console_ = async (user: string, ...roles: string[]) => ({ Authorization: `Bearer ${await token({ user, roles })}` });
  const portal = async (user: string, bank: string, ...roles: string[]) => ({
    Authorization: `Bearer ${await token({ user, roles, bank, client: 'portail' })}`,
  });

  beforeAll(async () => {
    process.env.DISABLE_JOBS = 'true';
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256' }] });
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: TEST_CONFIG,
          database: testDatabase(),
          clock: new FixedClock('2026-11-23'),
          gatewayAdmin: new InMemoryGatewayAdmin(),
          rightsStore: testRightsStore(),
          tokenVerifier: new KeycloakTokenVerifier(ISSUER, '', jwks),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    http = request(app.getHttpServer()) as any;

    for (const code of ['BNA', 'STB', 'ATB', 'OLD']) {
      const p = await http.post('/partners').set(SERVICE).send({ code, name: code }).expect(201);
      ids[code] = p.body.id;
      await http.post(`/partners/${p.body.id}/activate`).set(SERVICE).expect(200);
    }
    await http.post(`/partners/${ids.OLD}/terminate`).set(SERVICE).send({ reason: 'test' }).expect(200);
    const prov = await http.post('/providers').set(SERVICE).send({ name: 'SVIP', baseUrl: 'https://svip.interne', sandboxBaseUrl: 'http://sim' }).expect(201);
    const api = await http.post('/apis').set(SERVICE).send({ name: 'Cartes', slug: 'cartes-v1', publicPath: '/cartes/v1', upstreamPath: '/secret/cards', providerId: prov.body.id }).expect(201);
    ids.api = api.body.id;
    await http.post(`/apis/${ids.api}/status`).set(SERVICE).send({ status: 'PUBLISHED' }).expect(201);
    ids.plan = (await http.post('/plans').set(SERVICE).send({ name: 'Std', dailyQuota: 10, rateLimitPerSecond: 5 }).expect(201)).body.id;
  });

  afterAll(() => app.close());

  describe('Authentification', () => {
    it('refuse sans jeton, jeton falsifié, expiré ou d’un autre émetteur', async () => {
      await http.get('/disputes').expect(401);
      await http.get('/disputes').set({ Authorization: 'Bearer abc.def.ghi' }).expect(401);
      const expired = await token({ user: 'a', roles: ['console-admin'], exp: '-1m' });
      await http.get('/disputes').set({ Authorization: `Bearer ${expired}` }).expect(401);
      const other = await token({ user: 'a', roles: ['console-admin'], iss: 'https://pirate/realms/smt' });
      await http.get('/disputes').set({ Authorization: `Bearer ${other}` }).expect(401);
    });

    it('sépare les jetons : un jeton du portail est refusé par la console et inversement', async () => {
      await http.get('/partners').set(await portal('x', 'BNA', 'banque-admin-securite')).expect(403);
      await http.get('/portal/me').set(await console_('x', 'console-admin')).expect(403);
    });
  });

  describe('Console : droits par section', () => {
    it('agent litiges : lit les banques et les litiges, ne crée pas de banque', async () => {
      const h = await console_('lina', 'console-agent-litiges');
      await http.get('/disputes').set(h).expect(200);
      await http.get('/partners').set(h).expect(200);
      await http.post('/partners').set(h).send({ code: 'NEW', name: 'x' }).expect(403);
      await http.get('/usage/summary?from=2026-11-01&to=2026-11-30').set(h).expect(403);
    });

    it('auditeur : lit tout, n’écrit rien', async () => {
      const h = await console_('audit', 'console-auditeur');
      await http.get('/audit').set(h).expect(200);
      await http.get('/usage/summary?from=2026-11-01&to=2026-11-30').set(h).expect(200);
      await http.post('/plans').set(h).send({ name: 'P', dailyQuota: 1, rateLimitPerSecond: 1 }).expect(403);
    });

    it('facturation : finance oui, demandes non', async () => {
      const h = await console_('fact', 'console-facturation');
      await http.get('/usage/summary?from=2026-11-01&to=2026-11-30').set(h).expect(200);
      await http.post('/requests').set(h).send({ partnerId: ids.BNA, type: 'SUPPORT', subject: 'x' }).expect(403);
    });

    it('menu : sections visibles selon le rôle', async () => {
      const support = await http.get('/console/me').set(await console_('sam', 'console-agent-support')).expect(200);
      expect(support.body).toEqual({ username: 'sam', roles: ['console-agent-support'], sections: ['demandes', 'banques', 'catalogue'] });
      const auditor = await http.get('/console/me').set(await console_('aud', 'console-auditeur')).expect(200);
      expect(auditor.body.sections).toHaveLength(7);
      await http.get('/console/me').set(await console_('nobody', 'offline_access')).expect(403);
    });

    it('double validation avec les vraies identités et auteur tracé dans l’audit', async () => {
      const amel = await console_('amel', 'console-agent-operations');
      const karim = await console_('karim', 'console-agent-operations');
      const r = await http.post('/requests').set(amel).send({ partnerId: ids.BNA, type: 'OPERATION', subject: 'Plafond', sensitive: true }).expect(201);
      await http.post(`/requests/${r.body.id}/assign`).set(amel).send({ assignee: 'amel' }).expect(200);
      await http.post(`/requests/${r.body.id}/complete`).set(amel).expect(200);
      expect((await http.post(`/requests/${r.body.id}/validate`).set(amel).expect(409)).body.code).toBe('SAME_VALIDATOR');
      await http.post(`/requests/${r.body.id}/validate`).set(karim).expect(200);
      const audit = await http.get(`/audit?objectType=request&objectId=${r.body.id}`).set(SERVICE).expect(200);
      expect(audit.body.map((e: any) => e.actor)).toEqual(expect.arrayContaining(['amel', 'karim']));
      expect(audit.body.map((e: any) => e.actor)).not.toContain('init');
    });
  });

  describe('Portail : cloisonnement par banque', () => {
    it('profil : banque et menu déduits du jeton', async () => {
      const me = await http.get('/portal/me').set(await portal('op', 'BNA', 'banque-operateur-monetique')).expect(200);
      expect(me.body).toMatchObject({ username: 'op', partner: { code: 'BNA' }, sections: ['operations', 'demandes', 'developpeurs'] });
    });

    it('refuse : utilisateur sans banque, banque inconnue, banque résiliée, aucun rôle banque', async () => {
      await http.get('/portal/me').set({ Authorization: `Bearer ${await token({ user: 'x', roles: ['banque-lecture'], client: 'portail' })}` }).expect(403);
      await http.get('/portal/me').set(await portal('x', 'INCONNUE', 'banque-lecture')).expect(403);
      await http.get('/portal/me').set(await portal('x', 'OLD', 'banque-lecture')).expect(403);
      await http.get('/portal/me').set(await portal('x', 'BNA', 'offline_access')).expect(403);
    });

    it('demandes : la banque vient du jeton, jamais du corps ; une autre banque ne voit rien', async () => {
      const bna = await portal('op', 'BNA', 'banque-operateur-monetique');
      const stb = await portal('op', 'STB', 'banque-operateur-monetique');
      await http.post('/portal/requests').set(bna).send({ partnerId: ids.STB, type: 'SUPPORT', subject: 'x' }).expect(400);
      const r = await http.post('/portal/requests').set(bna).send({ type: 'OPERATION', subject: 'Opposition', context: { carte: '412345******2345' } }).expect(201);
      expect(r.body.partnerId).toBe(ids.BNA);
      await http.get(`/portal/requests/${r.body.id}`).set(stb).expect(404);
      await http.post(`/portal/requests/${r.body.id}/reply`).set(stb).expect(404);
      expect((await http.get('/portal/requests').set(stb).expect(200)).body).toHaveLength(0);
      expect((await http.get('/portal/requests').set(bna).expect(200)).body.every((x: any) => x.partnerId === ids.BNA)).toBe(true);
      const audit = await http.get(`/audit?objectType=request&objectId=${r.body.id}`).set(SERVICE).expect(200);
      expect(audit.body[0].actor).toBe('BNA:op');
    });

    it('lecture seule : consulte, ne crée pas', async () => {
      const h = await portal('ro', 'BNA', 'banque-lecture');
      await http.get('/portal/requests').set(h).expect(200);
      await http.post('/portal/requests').set(h).send({ type: 'SUPPORT', subject: 'x' }).expect(403);
    });

    it('litiges : rôle émetteur ou acquéreur déduit, tiers exclu', async () => {
      const bna = await portal('lit', 'BNA', 'banque-gestionnaire-litiges');
      const stb = await portal('lit', 'STB', 'banque-gestionnaire-litiges');
      const atb = await portal('lit', 'ATB', 'banque-gestionnaire-litiges');
      await http.post('/portal/disputes').set(await portal('op', 'BNA', 'banque-operateur-monetique'))
        .send({ acquirerCode: 'STB', transactionRef: 'T', maskedPan: '412345******2345', transactionDate: '2026-11-01', transactionAmount: 1000, reasonCode: '4853' }).expect(403);
      const d = await http.post('/portal/disputes').set(bna)
        .send({ acquirerCode: 'stb', transactionRef: 'T9', maskedPan: '412345******2345', transactionDate: '2026-11-01', transactionAmount: 50000, reasonCode: '4853' }).expect(201);
      expect(d.body).toMatchObject({ issuerId: ids.BNA, acquirerId: ids.STB });

      await http.get(`/portal/disputes/${d.body.id}`).set(atb).expect(404);
      expect((await http.get('/portal/disputes').set(atb).expect(200)).body).toHaveLength(0);
      // STB (acquéreur) ne peut pas faire le chargeback à la place de l'émetteur.
      expect((await http.post(`/portal/disputes/${d.body.id}/actions`).set(stb).send({ action: 'chargeback' }).expect(409)).body.code).toBe('NOT_YOUR_TURN');
      const cb = await http.post(`/portal/disputes/${d.body.id}/actions`).set(bna).send({ action: 'chargeback' }).expect(200);
      expect(cb.body.message).toEqual({ mti: '1442', functionCode: '450' });
      await http.post(`/portal/disputes/${d.body.id}/actions`).set(stb).send({ action: 'second-presentment', documentRef: 'doc' }).expect(200);
      await http.post(`/portal/disputes/${d.body.id}/actions`).set(atb).send({ action: 'accept' }).expect(404);
    });

    it('arbitrage : décision réservée à l’arbitre côté console', async () => {
      const d = await http.post('/disputes').set(SERVICE).send({ issuerId: ids.BNA, acquirerId: ids.STB, transactionRef: 'A1', maskedPan: '412345******2345', transactionDate: '2026-11-01', transactionAmount: 100, reasonCode: '4853' }).expect(201);
      const act = (body: object) => http.post(`/disputes/${d.body.id}/actions`).set(SERVICE).send(body).expect(200);
      await act({ action: 'chargeback', party: 'ISSUER' });
      await act({ action: 'second-presentment', party: 'ACQUIRER' });
      await act({ action: 'second-chargeback', party: 'ISSUER', documentRef: 'd2' });
      await act({ action: 'arbitration-request', party: 'ACQUIRER' });
      await http.post(`/disputes/${d.body.id}/decision`).set(await console_('lina', 'console-agent-litiges')).send({ winner: 'ISSUER' }).expect(403);
      await http.post(`/disputes/${d.body.id}/decision`).set(await console_('ali', 'console-arbitre')).send({ winner: 'ISSUER' }).expect(200);
    });

    it('développeurs : catalogue sans fournisseur ; mise en service à son nom ; PV signé par l’admin sécurité seul', async () => {
      const dev = await portal('dev', 'BNA', 'banque-developpeur');
      const cat = await http.get('/portal/catalogue').set(dev).expect(200);
      expect(cat.body[0]).toMatchObject({ slug: 'cartes-v1', publicPath: '/cartes/v1' });
      expect(cat.body[0].providerId).toBeUndefined();
      expect(cat.body[0].upstreamPath).toBeUndefined();

      const o = await http.post('/portal/onboardings').set(dev).send({ apiId: ids.api, planId: ids.plan }).expect(201);
      expect(o.body.partnerId).toBe(ids.BNA);
      await http.get(`/portal/onboardings/${o.body.id}`).set(await portal('dev', 'STB', 'banque-developpeur')).expect(404);
      await http.post(`/portal/onboardings/${o.body.id}/sign`).set(dev).expect(403);
      const admin = await portal('rssi', 'BNA', 'banque-admin-securite');
      expect((await http.post(`/portal/onboardings/${o.body.id}/sign`).set(admin).expect(409)).body.code).toBe('NOT_IN_ACCEPTANCE');
    });
  });
});
