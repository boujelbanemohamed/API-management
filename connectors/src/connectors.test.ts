import { describe, expect, it } from 'vitest';
import { sign, verify } from './cockpit/signature.js';
import { toIso } from './chargeback/mapping.js';
import { decodeBody, encode, parsePrivateData } from './iso8583.js';

describe('signature des webhooks Cockpit', () => {
  const now = 1_800_000_000_000;
  const body = '{"eventId":"e1","orderId":"r1","status":"DONE"}';
  const ts = String(now);
  it('accepte une signature valide et récente', () => expect(verify('secret', ts, sign('secret', ts, body), body, now)).toBe('ok'));
  it('refuse un corps modifié, un mauvais secret, une signature absente', () => {
    expect(verify('secret', ts, sign('secret', ts, body), body.replace('DONE', 'REJECTED'), now)).toBe('invalid');
    expect(verify('secret', ts, sign('autre', ts, body), body, now)).toBe('invalid');
    expect(verify('secret', undefined, undefined, body, now)).toBe('missing');
    expect(verify('secret', ts, 'zz', body, now)).toBe('invalid');
  });
  it('refuse un webhook rejoué au-delà de 5 minutes', () => {
    expect(verify('secret', ts, sign('secret', ts, body), body, now + 6 * 60_000)).toBe('expired');
  });
});

describe('litige → ISO 8583', () => {
  const m = { eventId: 'e1', disputeId: 'd1', mti: '1442', functionCode: '453', amount: 30000, currency: '788', maskedPan: '412345******2345', transactionRef: 'TX1', transactionDate: '2026-11-01', reasonCode: '4853', issuerCode: 'BNA', acquirerCode: 'STB' };
  it('produit un chargeback partiel lisible par la plateforme', () => {
    const iso = decodeBody(encode(toIso(m, '000007', '1126101500')).subarray(2));
    expect(iso).toMatchObject({ mti: '1442', fields: { 4: '000000030000', 11: '000007', 24: '453', 25: '4853', 31: 'TX1', 49: '788' } });
    expect(parsePrivateData(iso.fields[48])).toMatchObject({ PAN: '412345******2345', ISS: 'BNA', ACQ: 'STB', EVT: 'e1' });
  });
  it('refuse d’envoyer un numéro de carte non masqué', () => {
    expect(() => toIso({ ...m, maskedPan: '4123456789012345' }, '000001', '1126101500')).toThrow('non masqué');
  });
});
