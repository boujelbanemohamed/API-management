import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { FixedClock } from '../src/common/clock';
import { InMemoryGatewayAdmin } from '../src/gateway/gateway-admin';
import { KeycloakTokenVerifier } from '../src/auth/token-verifier';
import { FakeScanner, InMemoryFileStore } from '../src/files/storage';
import { InMemoryDirectory } from '../src/users/users.module';
import { RequestsService } from '../src/requests/requests.module';
import { TEST_CONFIG, testDatabase, testRightsStore } from './fixtures';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('Lot 5a — fichiers, notifications, contenus, gestion des accès', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let key: KeyLike;
  const clock = new FixedClock('2026-11-26');
  const scanner = new FakeScanner();
  const store = new InMemoryFileStore();
  const directory = new InMemoryDirectory();
  const S = { Authorization: `Bearer ${TEST_CONFIG.adminApiToken}`, 'x-actor': 'smt' };
  const ids: Record<string, string> = {};
  const tok = async (claims: Record<string, unknown>) =>
    `Bearer ${await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(TEST_CONFIG.keycloak.issuerUrl).setIssuedAt().setExpirationTime('5m').sign(key)}`;
  const bank = async (code: string, user: string, ...roles: string[]) => ({ Authorization: await tok({ preferred_username: user, azp: 'portail', realm_access: { roles }, partner_code: code }) });
  const smt = async (user: string, ...roles: string[]) => ({ Authorization: await tok({ preferred_username: user, azp: 'console', realm_access: { roles } }) });

  beforeAll(async () => {
    process.env.DISABLE_JOBS = 'true';
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256' }] });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ config: TEST_CONFIG, database: testDatabase(), clock, gatewayAdmin: new InMemoryGatewayAdmin(), rightsStore: testRightsStore(), tokenVerifier: new KeycloakTokenVerifier(TEST_CONFIG.keycloak.issuerUrl, '', jwks), fileStore: store, virusScanner: scanner, userDirectory: directory })],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    http = request(app.getHttpServer()) as any;
    for (const code of ['BNA', 'STB', 'ATB']) {
      ids[code] = (await http.post('/partners').set(S).send({ code, name: code }).expect(201)).body.id;
      await http.post(`/partners/${ids[code]}/activate`).set(S).expect(200);
    }
    directory.users.push({ id: 'rssi', username: 'rssi.bna', email: 'r@bna.tn', firstName: 'R', lastName: 'S', enabled: true, partnerCode: 'BNA', roles: ['banque-admin-securite'] });
    directory.users.push({ id: 'stbu', username: 'op.stb', email: 'o@stb.tn', firstName: 'O', lastName: 'P', enabled: true, partnerCode: 'STB', roles: ['banque-lecture'] });
  });
  afterAll(() => app.close());

  describe('Fichiers et antivirus', () => {
    it('pièce saine d’une demande : analysée, stockée, téléchargeable par la banque seule', async () => {
      const op = await bank('BNA', 'op', 'banque-operateur-monetique');
      ids.req = (await http.post('/portal/requests').set(op).send({ type: 'SUPPORT', subject: 'Question avec pièce' }).expect(201)).body.id;
      const f = await http.post('/portal/files').set(op).send({ ownerType: 'REQUEST', ownerId: ids.req, name: 'capture écran.png', mime: 'image/png', content: b64('PNG...') }).expect(201);
      expect(f.body).toMatchObject({ size: 6, partnerId: ids.BNA, uploadedBy: 'BNA:op' });
      expect(store.files.size).toBe(1);
      const dl = await http.get(`/portal/files/${f.body.id}/content`).set(op).expect(200);
      expect(dl.headers['content-disposition']).toContain("attachment; filename*=UTF-8''capture%20%C3%A9cran.png");
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      const stb = await bank('STB', 'op', 'banque-operateur-monetique');
      await http.get(`/portal/files/${f.body.id}/content`).set(stb).expect(404);
      await http.get(`/portal/files?ownerType=REQUEST&ownerId=${ids.req}`).set(stb).expect(404);
      await http.post('/portal/files').set(stb).send({ ownerType: 'REQUEST', ownerId: ids.req, name: 'x.txt', mime: 'text/plain', content: b64('x') }).expect(404);
      await http.get(`/files?ownerType=REQUEST&ownerId=${ids.req}`).set(await smt('amel', 'console-agent-support')).expect(200);
    });

    it('fichier infecté (EICAR) refusé et tracé ; antivirus indisponible : rien n’est stocké', async () => {
      const op = await bank('BNA', 'op', 'banque-operateur-monetique');
      const before = store.files.size;
      const r = await http.post('/portal/files').set(op).send({ ownerType: 'REQUEST', ownerId: ids.req, name: 'facture.txt', mime: 'text/plain', content: b64(EICAR) }).expect(409);
      expect(r.body).toMatchObject({ code: 'FILE_INFECTED' });
      expect(r.body.message).toContain('Eicar-Test-Signature');
      scanner.down = true;
      expect((await http.post('/portal/files').set(op).send({ ownerType: 'REQUEST', ownerId: ids.req, name: 'a.txt', mime: 'text/plain', content: b64('ok') }).expect(503)).body.code).toBe('FILE_SCAN_UNAVAILABLE');
      scanner.down = false;
      expect(store.files.size).toBe(before);
      const audit = await http.get(`/audit?objectType=request&objectId=${ids.req}`).set(S);
      expect(audit.body.some((a: any) => a.action === 'file.infected')).toBe(true);
    });

    it('type non accepté, fichier trop gros ou nom dangereux refusés', async () => {
      const op = await bank('BNA', 'op', 'banque-operateur-monetique');
      await http.post('/portal/files').set(op).send({ ownerType: 'REQUEST', ownerId: ids.req, name: 'x.exe', mime: 'application/x-msdownload', content: b64('MZ') }).expect(400);
      await http.post('/portal/files').set(op).send({ ownerType: 'REQUEST', ownerId: ids.req, name: '../../etc/passwd', mime: 'text/plain', content: b64('x') }).expect(400);
      expect((await http.post('/portal/files').set(op).send({ ownerType: 'REQUEST', ownerId: ids.req, name: 'gros.pdf', mime: 'application/pdf', content: b64(Buffer.alloc(3 * 1024 * 1024 + 1)) }).expect(409)).body.code).toBe('FILE_TOO_LARGE');
    });

    it('litige : justificatif visible des deux banques ; un justificatif d’un autre dossier est refusé', async () => {
      const lit = await bank('BNA', 'lit', 'banque-gestionnaire-litiges');
      const d = await http.post('/portal/disputes').set(lit).send({ acquirerCode: 'STB', transactionRef: 'F1', maskedPan: '412345******2345', transactionDate: '2026-11-01', transactionAmount: 10000, reasonCode: '4853' }).expect(201);
      ids.dispute = d.body.id;
      const f = await http.post('/portal/files').set(lit).send({ ownerType: 'DISPUTE', ownerId: d.body.id, name: 'ticket.pdf', mime: 'application/pdf', content: b64('%PDF') }).expect(201);
      await http.get(`/portal/files/${f.body.id}/content`).set(await bank('STB', 'lit', 'banque-gestionnaire-litiges')).expect(200);
      await http.get(`/portal/files/${f.body.id}/content`).set(await bank('ATB', 'lit', 'banque-gestionnaire-litiges')).expect(404);
      const reqFile = (await http.get(`/portal/files?ownerType=REQUEST&ownerId=${ids.req}`).set(await bank('BNA', 'op', 'banque-operateur-monetique'))).body[0].id;
      expect((await http.post(`/portal/disputes/${d.body.id}/actions`).set(lit).send({ action: 'chargeback', documentRef: reqFile }).expect(409)).body.code).toBe('DOCUMENT_UNKNOWN');
      await http.post(`/portal/disputes/${d.body.id}/actions`).set(lit).send({ action: 'chargeback', documentRef: f.body.id }).expect(200);
    });
  });

  describe('Notifications', () => {
    it('la banque est prévenue des changements, l’autre partie d’un litige aussi ; chacun ne lit que les siennes', async () => {
      await http.post(`/requests/${ids.req}/assign`).set(S).send({ assignee: 'amel' }).expect(200);
      const op = await bank('BNA', 'op', 'banque-operateur-monetique');
      const mine = (await http.get('/portal/notifications').set(op).expect(200)).body;
      expect(mine.some((n: any) => n.body.includes('est prise en charge') && n.link === `/demandes/${ids.req}`)).toBe(true);
      const stb = await bank('STB', 'lit', 'banque-gestionnaire-litiges');
      const theirs = (await http.get('/portal/notifications').set(stb).expect(200)).body;
      expect(theirs.some((n: any) => n.title === 'Litige : action de l’émetteur' && n.link === `/litiges/${ids.dispute}`)).toBe(true);
      await http.post(`/portal/notifications/${mine[0].id}/read`).set(stb).expect(404);
      await http.post(`/portal/notifications/${mine[0].id}/read`).set(op).expect(200);
      await http.post('/portal/notifications/read-all').set(op).expect(200);
      expect((await http.get('/portal/notifications').set(op)).body.every((n: any) => n.readAt)).toBe(true);
    });

    it('équipes SMT : nouvelle demande et alerte de délai, une fois par niveau', async () => {
      const support = await smt('sam', 'console-agent-support');
      expect((await http.get('/console/notifications').set(support)).body.some((n: any) => n.title === 'Nouvelle demande BNA')).toBe(true);
      const litiges = await smt('lina', 'console-agent-litiges');
      expect((await http.get('/console/notifications').set(litiges)).body.some((n: any) => n.title === 'Nouvelle demande BNA')).toBe(false);
      clock.set('2026-12-10');
      const requests = app.get(RequestsService);
      expect(await requests.checkSla()).toBeGreaterThan(0);
      expect(await requests.checkSla()).toBe(0);
      expect((await http.get('/console/notifications').set(support)).body.some((n: any) => n.title === 'Délai dépassé')).toBe(true);
      clock.set('2026-11-26');
    });
  });

  describe('Contenus', () => {
    it('communiqué ciblé : visible et notifié seulement pour les banques choisies', async () => {
      const c = await http.post('/contents').set(S).send({ kind: 'COMMUNIQUE', title: 'Maintenance du 30 novembre', body: 'Interruption de 2 h.', important: true, audience: 'SELECTED', partnerIds: [ids.BNA] }).expect(201);
      expect((await http.get('/portal/contents').set(await bank('BNA', 'op', 'banque-lecture'))).body).toHaveLength(0); // brouillon
      await http.post(`/contents/${c.body.id}/publish`).set(S).expect(200);
      const bna = (await http.get('/portal/contents?kind=COMMUNIQUE').set(await bank('BNA', 'op', 'banque-lecture'))).body;
      expect(bna[0]).toMatchObject({ title: 'Maintenance du 30 novembre', important: true });
      expect(bna[0].partnerIds).toBeUndefined();
      expect((await http.get('/portal/contents').set(await bank('STB', 'op', 'banque-lecture'))).body).toHaveLength(0);
      await http.get(`/portal/contents/${c.body.id}`).set(await bank('STB', 'op', 'banque-lecture')).expect(404);
      expect((await http.get('/portal/notifications').set(await bank('BNA', 'op', 'banque-lecture'))).body.some((n: any) => n.title === 'Nouveau communiqué')).toBe(true);
    });

    it('enquête : une réponse par utilisateur, réponses contrôlées, résultats agrégés', async () => {
      const e = await http.post('/contents').set(S).send({ kind: 'ENQUETE', title: 'Satisfaction', questions: [{ id: 'note', label: 'Votre note', type: 'choice', options: ['1', '2', '3'] }, { id: 'avis', label: 'Un avis', type: 'text' }] }).expect(201);
      await http.post(`/contents/${e.body.id}/publish`).set(S).expect(200);
      const h = await bank('BNA', 'op', 'banque-lecture');
      expect((await http.post(`/portal/contents/${e.body.id}/responses`).set(h).send({ answers: { note: '9', avis: 'x' } }).expect(409)).body.code).toBe('ANSWER_INVALID');
      expect((await http.post(`/portal/contents/${e.body.id}/responses`).set(h).send({ answers: { note: '3' } }).expect(409)).body.code).toBe('ANSWER_MISSING');
      await http.post(`/portal/contents/${e.body.id}/responses`).set(h).send({ answers: { note: '3', avis: 'Très bien' } }).expect(201);
      expect((await http.post(`/portal/contents/${e.body.id}/responses`).set(h).send({ answers: { note: '2', avis: 'x' } }).expect(409)).body.code).toBe('ALREADY_ANSWERED');
      expect((await http.get('/portal/contents?kind=ENQUETE').set(h)).body[0].answered).toBe(true);
      const r = (await http.get(`/contents/${e.body.id}/results`).set(S)).body;
      expect(r).toMatchObject({ total: 1, questions: [{ counts: { '1': 0, '2': 0, '3': 1 } }, { texts: [{ bank: 'BNA', text: 'Très bien' }] }] });
    });

    it('bibliothèque : document versionné, fichier analysé, téléchargeable par les banques concernées', async () => {
      const doc = await http.post('/contents').set(S).send({ kind: 'DOCUMENT', title: 'Procédure litiges', category: 'Procédures' }).expect(201);
      expect((await http.post(`/contents/${doc.body.id}/publish`).set(S).expect(409)).body.code).toBe('DOCUMENT_WITHOUT_FILE');
      expect((await http.post(`/contents/${doc.body.id}/file`).set(S).send({ name: 'v1.pdf', mime: 'application/pdf', content: b64(EICAR) }).expect(409)).body.code).toBe('FILE_INFECTED');
      await http.post(`/contents/${doc.body.id}/file`).set(S).send({ name: 'v1.pdf', mime: 'application/pdf', content: b64('%PDF v1') }).expect(201);
      const v2 = await http.post(`/contents/${doc.body.id}/file`).set(S).send({ name: 'v2.pdf', mime: 'application/pdf', content: b64('%PDF v2') }).expect(201);
      expect(v2.body.version).toBe(2);
      await http.post(`/contents/${doc.body.id}/publish`).set(S).expect(200);
      const h = await bank('ATB', 'x', 'banque-lecture');
      const one = (await http.get(`/portal/contents/${doc.body.id}`).set(h).expect(200)).body;
      expect(one.files.map((f: any) => f.name)).toEqual(['v1.pdf', 'v2.pdf']);
      expect((await http.get(`/portal/contents/files/${one.files[1].id}`).set(h).expect(200)).body.toString()).toBe('%PDF v2');
      await http.get(`/portal/files/${one.files[1].id}/content`).set(h).expect(404); // pas par la route des pièces
      await http.post(`/contents/${doc.body.id}/archive`).set(S).expect(200);
      await http.get(`/portal/contents/files/${one.files[1].id}`).set(h).expect(404);
    });

    it('seul l’administrateur publie (section Administration)', async () => {
      await http.post('/contents').set(await smt('sam', 'console-agent-support')).send({ kind: 'COMMUNIQUE', title: 'x' }).expect(403);
    });
  });

  describe('Gestion des accès', () => {
    it('l’administrateur sécurité crée un utilisateur de sa banque, avec des rôles banque seulement', async () => {
      const rssi = await bank('BNA', 'rssi.bna', 'banque-admin-securite');
      expect((await http.post('/portal/users').set(rssi).send({ username: 'dev.bna', email: 'd@bna.tn', firstName: 'D', lastName: 'V', roles: ['console-admin'] }).expect(409)).body.code).toBe('ROLE_NOT_ALLOWED');
      const u = await http.post('/portal/users').set(rssi).send({ username: 'dev.bna', email: 'd@bna.tn', firstName: 'D', lastName: 'V', roles: ['banque-developpeur'] }).expect(201);
      expect(u.body.temporaryPassword).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#%+=?]).{16}$/);
      expect(directory.users.find((x) => x.username === 'dev.bna')).toMatchObject({ partnerCode: 'BNA', roles: ['banque-developpeur'] });
      expect((await http.get('/portal/users').set(rssi)).body.map((x: any) => x.username).sort()).toEqual(['dev.bna', 'rssi.bna']);
    });

    it('ne peut ni retirer son propre rôle d’administrateur, ni se désactiver, ni toucher une autre banque', async () => {
      const rssi = await bank('BNA', 'rssi.bna', 'banque-admin-securite');
      expect((await http.put('/portal/users/rssi/roles').set(rssi).send({ roles: ['banque-lecture'] }).expect(409)).body.code).toBe('SELF_ADMIN_REMOVAL');
      expect((await http.post('/portal/users/rssi/disable').set(rssi).expect(409)).body.code).toBe('SELF_DISABLE');
      await http.post('/portal/users/stbu/disable').set(rssi).expect(404);
      await http.get('/portal/users').set(await bank('BNA', 'op', 'banque-operateur-monetique')).expect(403);
      const dev = directory.users.find((x) => x.username === 'dev.bna')!;
      await http.put(`/portal/users/${dev.id}/roles`).set(rssi).send({ roles: ['banque-developpeur', 'banque-facturation'] }).expect(200);
      await http.post(`/portal/users/${dev.id}/disable`).set(rssi).expect(200);
      expect(dev).toMatchObject({ enabled: false, roles: ['banque-developpeur', 'banque-facturation'] });
    });

    it('console : l’administrateur SMT gère les utilisateurs SMT, avec des rôles console seulement', async () => {
      const admin = await smt('admin.smt', 'console-admin');
      await http.post('/console/users').set(admin).send({ username: 'agent.x', email: 'a@smt.tn', firstName: 'A', lastName: 'X', roles: ['banque-lecture'] }).expect(409);
      await http.post('/console/users').set(admin).send({ username: 'agent.x', email: 'a@smt.tn', firstName: 'A', lastName: 'X', roles: ['console-agent-support'] }).expect(201);
      expect((await http.get('/console/users').set(admin)).body.map((x: any) => x.username)).toEqual(['agent.x']);
      await http.get('/console/users').set(await smt('sam', 'console-agent-support')).expect(403);
    });
  });
});
