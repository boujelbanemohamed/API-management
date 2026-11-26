/**
 * Codec ISO 8583:1993, encodage ASCII, bitmap hexadécimal, trame préfixée par 2 octets de longueur (big-endian).
 * Seuls les champs utilisés par les litiges du scheme national sont définis ; le format exact
 * reste à confirmer avec la spécification de la plateforme Chargeback.
 *
 * Jamais de numéro de carte complet : le champ 2 n'est pas utilisé, la carte masquée part en données privées (48).
 */

type Kind = 'n' | 'an' | 'ans';
interface FieldSpec {
  kind: Kind;
  /** Longueur fixe, ou maximale pour un champ variable. */
  length: number;
  /** Préfixe de longueur : 0 = fixe, 2 = LLVAR, 3 = LLLVAR. */
  prefix: 0 | 2 | 3;
  name: string;
}

export const FIELDS: Record<number, FieldSpec> = {
  3: { kind: 'n', length: 6, prefix: 0, name: 'Code traitement' },
  4: { kind: 'n', length: 12, prefix: 0, name: 'Montant de la transaction' },
  7: { kind: 'n', length: 10, prefix: 0, name: 'Date et heure de transmission (MMJJhhmmss)' },
  11: { kind: 'n', length: 6, prefix: 0, name: 'Numéro de trace (STAN)' },
  12: { kind: 'n', length: 12, prefix: 0, name: 'Date et heure locales (AAMMJJhhmmss)' },
  24: { kind: 'n', length: 3, prefix: 0, name: 'Code fonction' },
  25: { kind: 'n', length: 4, prefix: 0, name: 'Code motif du message' },
  31: { kind: 'ans', length: 99, prefix: 2, name: 'Données de référence acquéreur' },
  39: { kind: 'n', length: 3, prefix: 0, name: 'Code action' },
  48: { kind: 'ans', length: 999, prefix: 3, name: 'Données privées' },
  49: { kind: 'n', length: 3, prefix: 0, name: 'Code devise' },
};

export interface IsoMessage {
  mti: string;
  fields: Record<number, string>;
}

export class IsoError extends Error {}

const CHARSETS: Record<Kind, RegExp> = {
  n: /^[0-9]*$/,
  an: /^[A-Za-z0-9]*$/,
  ans: /^[\x20-\x7E]*$/,
};

function encodeField(no: number, value: string): string {
  const spec = FIELDS[no];
  if (!spec) throw new IsoError(`Champ ${no} non défini`);
  if (!CHARSETS[spec.kind].test(value)) throw new IsoError(`Champ ${no} (${spec.name}) : caractères non autorisés`);
  if (spec.prefix === 0) {
    if (value.length > spec.length) throw new IsoError(`Champ ${no} : ${value.length} caractères pour ${spec.length}`);
    return spec.kind === 'n' ? value.padStart(spec.length, '0') : value.padEnd(spec.length, ' ');
  }
  if (value.length > spec.length) throw new IsoError(`Champ ${no} : longueur ${value.length} > ${spec.length}`);
  return String(value.length).padStart(spec.prefix, '0') + value;
}

export function encode(msg: IsoMessage): Buffer {
  if (!/^1\d{3}$/.test(msg.mti)) throw new IsoError(`MTI ISO 8583:1993 invalide : ${msg.mti}`);
  const numbers = Object.keys(msg.fields).map(Number).sort((a, b) => a - b);
  if (numbers.some((n) => n < 2 || n > 128)) throw new IsoError('Numéro de champ hors 2..128');
  const secondary = numbers.some((n) => n > 64);
  const bits = new Array<number>(secondary ? 128 : 64).fill(0);
  if (secondary) bits[0] = 1;
  for (const n of numbers) bits[n - 1] = 1;
  let bitmap = '';
  for (let i = 0; i < bits.length; i += 4) bitmap += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16).toUpperCase();
  const body = msg.mti + bitmap + numbers.map((n) => encodeField(n, msg.fields[n])).join('');
  const payload = Buffer.from(body, 'ascii');
  if (payload.length > 0xffff) throw new IsoError('Message trop long');
  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** Décode le corps d'un message (sans l'en-tête de longueur). */
export function decodeBody(body: Buffer | string): IsoMessage {
  const s = typeof body === 'string' ? body : body.toString('ascii');
  let pos = 0;
  const take = (n: number) => {
    if (pos + n > s.length) throw new IsoError('Message tronqué');
    const v = s.slice(pos, pos + n);
    pos += n;
    return v;
  };
  const mti = take(4);
  if (!/^1\d{3}$/.test(mti)) throw new IsoError(`MTI invalide : ${mti}`);
  let hex = take(16);
  if (parseInt(hex[0], 16) & 0x8) hex += take(16);
  if (!/^[0-9A-Fa-f]+$/.test(hex)) throw new IsoError('Bitmap invalide');
  const bits = [...hex].flatMap((h) => parseInt(h, 16).toString(2).padStart(4, '0').split('').map(Number));
  const fields: Record<number, string> = {};
  for (let i = 1; i < bits.length; i++) {
    if (!bits[i]) continue;
    const no = i + 1;
    const spec = FIELDS[no];
    if (!spec) throw new IsoError(`Champ ${no} présent mais non défini`);
    const len = spec.prefix === 0 ? spec.length : Number(take(spec.prefix));
    if (Number.isNaN(len) || len > spec.length) throw new IsoError(`Longueur invalide pour le champ ${no}`);
    const raw = take(len);
    fields[no] = spec.kind === 'n' || spec.prefix > 0 ? raw : raw.trimEnd();
  }
  if (pos !== s.length) throw new IsoError('Octets en trop en fin de message');
  return { mti, fields };
}

/** Découpe un flux TCP en trames (en-tête de 2 octets). */
export class FrameReader {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 2) {
      const len = this.buffer.readUInt16BE(0);
      if (this.buffer.length < 2 + len) break;
      frames.push(this.buffer.subarray(2, 2 + len));
      this.buffer = this.buffer.subarray(2 + len);
    }
    return frames;
  }
}

/** MTI de la réponse : le chiffre « fonction » augmente de 1 (1442 → 1452, 1804 → 1814). */
export function responseMti(mti: string): string {
  return mti.slice(0, 2) + String(Number(mti[2]) + 1) + mti[3];
}

/** Données privées (champ 48) : liste clé=valeur séparée par des points-virgules. */
export function privateData(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${v.replace(/[;=]/g, ' ')}`)
    .join(';');
}

export function parsePrivateData(s: string | undefined): Record<string, string> {
  return Object.fromEntries((s ?? '').split(';').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
}

/** Codes action (champ 39) : 000 = accepté ; les autres sont des refus de la plateforme. */
export const ACTION_OK = '000';
export const ACTION_ECHO_OK = '800';
