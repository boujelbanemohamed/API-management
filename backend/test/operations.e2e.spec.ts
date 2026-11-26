import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { FixedClock } from '../src/common/clock';
import { InMemoryGatewayAdmin } from '../src/gateway/gateway-admin';
import { KeycloakTokenVerifier } from '../src/auth/token-verifier';
import { OperationsClient, ProviderKey, ProviderUnavailable } from '../src/operations/operations.module';
import { TEST_CONFIG, testDatabase, testRightsStore } from './fixtures';

/** Fournisseur factice : renvoie volontairement des données d'une autre banque et un numéro complet. */
class FakeProviders implements OperationsClient {
  down = new Set<ProviderKey>();
  calls: { provider: string; path: string; bank: string; query?: Record<string, string | undefined> }[] = [];
  async get(provider: ProviderKey, path: string, bank: string, query?: Record<string, string | undefined>) {
    this.calls.push({ provider, path, bank, query });
    if (this.down.has(provider)) throw new ProviderUnavailable(provider);
    if (path === 'transactions') return [
      { reference: 'BNA001', bank: 'BNA', maskedPan: '412345******2345', amount: 1000 },
      { reference: 'STB001', bank: 'STB', maskedPan: '412345******9999', amount: 2000 },
      { reference: 'BNA002', bank: 'BNA', maskedPan: '4123456789012345', amount: 3000, note: 'carte 5355221234567890' },
    ];
    if (path === 'transactions/STB001') return { reference: 'STB001', bank: 'STB' };
    if (path === 'transactions/BNA001') return { reference: 'BNA001', bank: 'BNA', maskedPan: '412345******2345' };
    if (path.startsWith('transactions/')) return null;
    if (path === 'atms') return [{ id: 'G1', bank: 'BNA', status: 'EN_SERVICE' }];
    return [];
  }
}

describe('Lot 4b — services opérationnels (BFF du portail)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let key: KeyLike;
  const providers = new FakeProviders();
  const S = { Authorization: `Bearer ${TEST_CONFIG.adminApiToken}` };
  const portal = async (bank: string, ...roles: string[]) => ({
    Authorization: `Bearer ${await new SignJWT({ preferred_username: 'u', azp: 'portail', realm_access: { roles }, partner_code: bank })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(TEST_CONFIG.keycloak.issuerUrl).setIssuedAt().setExpirationTime('5m').sign(key)}`,
  });

  beforeAll(async () => {
    process.env.DISABLE_JOBS = 'true';
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256' }] });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ config: TEST_CONFIG, database: testDatabase(), clock: new FixedClock('2026-11-26'), gatewayAdmin: new InMemoryGatewayAdmin(), rightsStore: testRightsStore(), tokenVerifier: new KeycloakTokenVerifier(TEST_CONFIG.keycloak.issuerUrl, '', jwks), operationsClient: providers })],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    http = request(app.getHttpServer()) as any;
    for (const code of ['BNA', 'STB']) await http.post('/partners').set(S).send({ code, name: code }).expect(201);
  });
  afterAll(() => app.close());

  it('ne renvoie que les données de la banque du jeton, cartes toujours masquées, source indiquée', async () => {
    const r = await http.get('/portal/operations/transactions?from=2026-11-01&pan=412345').set(await portal('BNA', 'banque-operateur-monetique')).expect(200);
    expect(r.body.source).toBe('Plateforme 1');
    expect(r.body.items.map((t: any) => t.reference)).toEqual(['BNA001', 'BNA002']);
    expect(r.body.items[1].maskedPan).toBe('412345******2345');
    expect(r.body.items[1].note).toBe('carte 535522******7890');
    expect(JSON.stringify(r.body)).not.toMatch(/\d{13,19}/);
    expect(r.body.items[0].bank).toBeUndefined();
    expect(providers.calls.at(-1)).toMatchObject({ provider: 'p1', bank: 'BNA', query: { from: '2026-11-01', pan: '412345' } });
  });

  it('détail : élément d’une autre banque ou inexistant → 404', async () => {
    const h = await portal('BNA', 'banque-operateur-monetique');
    await http.get('/portal/operations/transactions/BNA001').set(h).expect(200);
    await http.get('/portal/operations/transactions/STB001').set(h).expect(404);
    await http.get('/portal/operations/transactions/INCONNU').set(h).expect(404);
    await http.get('/portal/operations/transactions/..%2F..%2Fadmin').set(h).expect(404);
  });

  it('fournisseur indisponible : 503 avec le nom du fournisseur et une proposition de demande', async () => {
    providers.down.add('cockpit');
    const r = await http.get('/portal/operations/atms').set(await portal('BNA', 'banque-operateur-monetique')).expect(503);
    expect(r.body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(r.body.message).toContain('SMT Cockpit');
    providers.down.delete('cockpit');
    await http.get('/portal/operations/atms').set(await portal('BNA', 'banque-operateur-monetique')).expect(200);
  });

  it('droits : opérateur et lecture seule oui, développeur non', async () => {
    await http.get('/portal/operations/cards').set(await portal('BNA', 'banque-lecture')).expect(200);
    await http.get('/portal/operations/cards').set(await portal('BNA', 'banque-developpeur')).expect(403);
    await http.get('/portal/operations/cards').set(S).expect(401);
  });
});
