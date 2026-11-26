import net from 'node:net';

/**
 * Stockage des fichiers (SeaweedFS, API du filer) et analyse antivirus (ClamAV, protocole clamd INSTREAM).
 * Aucun fichier n'est stocké sans avoir été analysé et trouvé sain.
 */
export interface FileStore {
  put(key: string, content: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export type ScanResult = { clean: true } | { clean: false; signature: string };

export interface VirusScanner {
  scan(content: Buffer): Promise<ScanResult>;
}

export const FILE_STORE = Symbol('FILE_STORE');
export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

export class ScannerUnavailable extends Error {}
export class StoreUnavailable extends Error {}

/** SeaweedFS : POST multipart sur le filer pour écrire, GET pour lire, DELETE pour supprimer. */
export class SeaweedFilerStore implements FileStore {
  constructor(private readonly baseUrl: string, private readonly root = '/apim') {}

  private url(key: string) {
    return `${this.baseUrl.replace(/\/$/, '')}${this.root}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, content: Buffer, mime: string): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)], { type: mime }), key.split('/').pop());
    const res = await fetch(this.url(key), { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) }).catch((e) => {
      throw new StoreUnavailable((e as Error).message);
    });
    if (!res.ok) throw new StoreUnavailable(`filer ${res.status}`);
  }

  async get(key: string): Promise<Buffer> {
    const res = await fetch(this.url(key), { signal: AbortSignal.timeout(30_000) }).catch((e) => {
      throw new StoreUnavailable((e as Error).message);
    });
    if (!res.ok) throw new StoreUnavailable(`filer ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    await fetch(this.url(key), { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
}

/** ClamAV (clamd) : commande zINSTREAM, morceaux préfixés par leur longueur sur 4 octets, terminés par 0. */
export class ClamdScanner implements VirusScanner {
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 30_000) {}

  scan(content: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let reply = '';
      const fail = (e: Error) => {
        socket.destroy();
        reject(new ScannerUnavailable(e.message));
      };
      socket.setTimeout(this.timeoutMs, () => fail(new Error('délai dépassé')));
      socket.once('error', fail);
      socket.on('data', (d) => (reply += d.toString()));
      socket.on('end', () => {
        const text = reply.replace(/\0/g, '').trim();
        if (/: OK$/.test(text)) return resolve({ clean: true });
        const found = text.match(/: (.+) FOUND$/);
        if (found) return resolve({ clean: false, signature: found[1] });
        reject(new ScannerUnavailable(`réponse inattendue : ${text.slice(0, 120)}`));
      });
      socket.once('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < content.length; i += 64 * 1024) {
          const chunk = content.subarray(i, i + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/** Pour les tests : stockage en mémoire. */
export class InMemoryFileStore implements FileStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, content: Buffer) {
    this.files.set(key, content);
  }
  async get(key: string) {
    const f = this.files.get(key);
    if (!f) throw new StoreUnavailable('absent');
    return f;
  }
  async remove(key: string) {
    this.files.delete(key);
  }
}

/** Pour les tests : détecte la chaîne de test EICAR, comme un vrai antivirus. */
export class FakeScanner implements VirusScanner {
  down = false;
  async scan(content: Buffer): Promise<ScanResult> {
    if (this.down) throw new ScannerUnavailable('antivirus injoignable');
    return content.toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? { clean: false, signature: 'Eicar-Test-Signature' } : { clean: true };
  }
}
