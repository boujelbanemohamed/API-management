import net from 'node:net';
import { decodeBody, encode, FrameReader, IsoMessage, responseMti } from '../iso8583.js';
import { log } from '../bus.js';

/**
 * Connexion TCP persistante vers la plateforme Chargeback.
 * Les réponses sont rapprochées des requêtes par le numéro de trace (STAN, champ 11) et le MTI attendu.
 */
export class IsoClient {
  private socket?: net.Socket;
  private connecting?: Promise<net.Socket>;
  private readonly pending = new Map<string, { resolve: (m: IsoMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stan = Math.floor(Math.random() * 900000);

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 10_000,
  ) {}

  nextStan(): string {
    this.stan = (this.stan % 999999) + 1;
    return String(this.stan).padStart(6, '0');
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    this.connecting ??= new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port });
      const reader = new FrameReader();
      s.setKeepAlive(true, 30_000);
      s.once('connect', () => {
        log('info', 'Liaison ISO 8583 établie', { host: this.host, port: this.port });
        this.socket = s;
        this.connecting = undefined;
        resolve(s);
      });
      s.on('data', (chunk) => {
        for (const frame of reader.push(chunk)) {
          try {
            const msg = decodeBody(frame);
            const key = `${msg.mti}:${msg.fields[11]}`;
            const p = this.pending.get(key);
            if (!p) {
              log('warn', 'Réponse ISO sans requête correspondante', { mti: msg.mti, stan: msg.fields[11] });
              continue;
            }
            clearTimeout(p.timer);
            this.pending.delete(key);
            p.resolve(msg);
          } catch (e) {
            log('error', `Trame ISO illisible : ${(e as Error).message}`);
          }
        }
      });
      const fail = (e: Error) => {
        this.connecting = undefined;
        this.socket = undefined;
        for (const [k, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`liaison coupée : ${e.message}`));
          this.pending.delete(k);
        }
        reject(e);
      };
      s.once('error', fail);
      s.once('close', () => fail(new Error('connexion fermée')));
    });
    return this.connecting;
  }

  /** Envoie une requête et attend sa réponse (rejet après `timeoutMs`). */
  async send(msg: IsoMessage): Promise<IsoMessage> {
    const socket = await this.connect();
    const stan = msg.fields[11];
    if (!stan) throw new Error('STAN (champ 11) obligatoire');
    const key = `${responseMti(msg.mti)}:${stan}`;
    return new Promise<IsoMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`pas de réponse sous ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      socket.write(encode(msg));
    });
  }

  close() {
    this.socket?.destroy();
  }
}

/** Champ 7 (MMJJhhmmss) en heure UTC, comme d'usage pour la date de transmission. */
export function transmissionDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
