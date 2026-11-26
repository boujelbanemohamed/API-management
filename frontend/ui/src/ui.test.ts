import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, configureApi } from './api';
import { formatAmount, FULL_PAN, MASKED_PAN, monthBounds, toMillimes } from './format';

describe('formats', () => {
  it('convertit dinars et millimes', () => {
    expect(toMillimes('120,500')).toBe(120500);
    expect(toMillimes('50')).toBe(50000);
    expect(formatAmount(120500).replace(/\s/g, ' ')).toBe('120,500 TND');
  });
  it('n’accepte que le numéro de carte masqué', () => {
    expect(MASKED_PAN.test('412345******2345')).toBe(true);
    expect(MASKED_PAN.test('4123456789012345')).toBe(false);
    expect(FULL_PAN.test('carte 4123456789012345')).toBe(true);
  });
  it('bornes du mois', () => {
    expect(monthBounds('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('client HTTP', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('envoie le jeton et rend le message métier du back-end', async () => {
    configureApi({ baseUrl: '/api', token: async () => 'jeton' });
    reply(409, { statusCode: 409, code: 'NOT_YOUR_TURN', message: 'À cette étape, c’est à ISSUER d’agir.' });
    const err = await api('/portal/disputes/1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'NOT_YOUR_TURN', message: 'À cette étape, c’est à ISSUER d’agir.' });
    expect((fetch as any).mock.calls[0][1].headers.Authorization).toBe('Bearer jeton');
  });
  it('masque les détails techniques des autres erreurs', async () => {
    reply(500, { message: 'QueryFailedError: relation x' });
    await expect(api('/x')).rejects.toThrow('Le service est momentanément indisponible.');
    reply(404, {});
    await expect(api('/x')).rejects.toThrow('Élément introuvable.');
  });
});
