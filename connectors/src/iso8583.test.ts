import { describe, expect, it } from 'vitest';
import { decodeBody, encode, FrameReader, IsoError, parsePrivateData, privateData, responseMti } from './iso8583.js';

const chargeback = {
  mti: '1442',
  fields: {
    4: '30000',
    7: '1123143000',
    11: '000042',
    24: '453',
    25: '4853',
    31: 'TX-2026-0001',
    48: privateData({ PAN: '412345******2345', ISS: 'BNA', ACQ: 'STB', EVT: 'e1' }),
    49: '788',
  },
};

describe('ISO 8583:1993', () => {
  it('encode puis décode à l’identique, montant complété à 12 chiffres', () => {
    const frame = encode(chargeback);
    expect(frame.readUInt16BE(0)).toBe(frame.length - 2);
    const body = frame.subarray(2).toString('ascii');
    expect(body.startsWith('1442')).toBe(true);
    const back = decodeBody(frame.subarray(2));
    expect(back.mti).toBe('1442');
    expect(back.fields[4]).toBe('000000030000');
    expect(back.fields[24]).toBe('453');
    expect(back.fields[31]).toBe('TX-2026-0001');
    expect(parsePrivateData(back.fields[48])).toEqual({ PAN: '412345******2345', ISS: 'BNA', ACQ: 'STB', EVT: 'e1' });
  });

  it('bitmap primaire exact', () => {
    const body = encode({ mti: '1804', fields: { 7: '1123143000', 11: '000001', 24: '831' } }).subarray(2).toString('ascii');
    // champs 7, 11, 24 → bits 7, 11, 24 à 1
    expect(body.slice(4, 20)).toBe('0220010000000000');
  });

  it('refuse un MTI de 1987, un champ numérique non numérique, un champ trop long ou inconnu', () => {
    expect(() => encode({ mti: '0200', fields: {} })).toThrow(IsoError);
    expect(() => encode({ mti: '1442', fields: { 4: '12,5' } })).toThrow('caractères');
    expect(() => encode({ mti: '1442', fields: { 24: '4530' } })).toThrow(IsoError);
    expect(() => encode({ mti: '1442', fields: { 2: '4123456789012345' } })).toThrow('non défini');
  });

  it('refuse un message tronqué ou avec des octets en trop', () => {
    const body = encode(chargeback).subarray(2).toString('ascii');
    expect(() => decodeBody(body.slice(0, -3))).toThrow('tronqué');
    expect(() => decodeBody(body + 'X')).toThrow('en trop');
  });

  it('découpe un flux TCP en trames, même arrivées en morceaux', () => {
    const a = encode(chargeback);
    const b = encode({ mti: '1804', fields: { 11: '000002', 24: '831' } });
    const all = Buffer.concat([a, b]);
    const reader = new FrameReader();
    const frames = [...reader.push(all.subarray(0, 5)), ...reader.push(all.subarray(5, a.length + 3)), ...reader.push(all.subarray(a.length + 3))];
    expect(frames.map((f) => decodeBody(f).mti)).toEqual(['1442', '1804']);
  });

  it('MTI de réponse', () => {
    expect(['1442', '1240', '1644', '1740', '1804'].map(responseMti)).toEqual(['1452', '1250', '1654', '1750', '1814']);
  });
});
