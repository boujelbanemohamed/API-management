import Redis from 'ioredis';
import { AccessRight } from './gateway.types';

/** Stockage des droits lus par le plugin subscription-guard à chaque appel. */
export interface RightsStore {
  /** Remplace l'ensemble des droits : écrit ceux fournis, supprime les autres. */
  replaceAll(rights: Record<string, AccessRight>): Promise<{ written: number; deleted: number }>;
  get(key: string): Promise<AccessRight | null>;
}

export const RIGHTS_STORE = Symbol('RIGHTS_STORE');

/** Valkey (compatible Redis). Clés : <prefix>:sub:<consumer>:<route_id> */
export class ValkeyRightsStore implements RightsStore {
  constructor(private readonly client: Redis, private readonly prefix: string) {}

  async replaceAll(rights: Record<string, AccessRight>): Promise<{ written: number; deleted: number }> {
    const wanted = new Set(Object.keys(rights).map((k) => this.full(k)));
    const existing = await this.scan(`${this.prefix}:sub:*`);
    const toDelete = existing.filter((k) => !wanted.has(k));

    const pipeline = this.client.multi();
    for (const [key, right] of Object.entries(rights)) pipeline.set(this.full(key), JSON.stringify(right));
    if (toDelete.length) pipeline.del(...toDelete);
    await pipeline.exec();
    return { written: wanted.size, deleted: toDelete.length };
  }

  async get(key: string): Promise<AccessRight | null> {
    const raw = await this.client.get(this.full(key));
    return raw ? (JSON.parse(raw) as AccessRight) : null;
  }

  private full(key: string): string {
    return `${this.prefix}:${key}`;
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }
}

export class InMemoryRightsStore implements RightsStore {
  readonly data = new Map<string, AccessRight>();

  async replaceAll(rights: Record<string, AccessRight>): Promise<{ written: number; deleted: number }> {
    let deleted = 0;
    for (const key of [...this.data.keys()]) {
      if (!(key in rights)) {
        this.data.delete(key);
        deleted++;
      }
    }
    for (const [key, right] of Object.entries(rights)) this.data.set(key, structuredClone(right));
    return { written: Object.keys(rights).length, deleted };
  }

  async get(key: string): Promise<AccessRight | null> {
    return this.data.get(key) ?? null;
  }
}
