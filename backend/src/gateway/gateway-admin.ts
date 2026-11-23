import { ApisixConsumer, ApisixRoute, MANAGED_LABEL } from './gateway.types';

/** Opérations sur la passerelle. Implémentation réelle : API d'administration APISIX. */
export interface GatewayAdmin {
  putConsumer(consumer: ApisixConsumer): Promise<void>;
  deleteConsumer(username: string): Promise<void>;
  putCredential(username: string, credentialId: string, plugins: Record<string, unknown>): Promise<void>;
  putRoute(route: ApisixRoute): Promise<void>;
  deleteRoute(id: string): Promise<void>;
  /** Uniquement les objets portant le label managed_by=api-platform. */
  listManagedConsumers(): Promise<string[]>;
  listManagedRoutes(): Promise<string[]>;
}

export const GATEWAY_ADMIN = Symbol('GATEWAY_ADMIN');

export class GatewayAdminError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

/** Client de l'API d'administration APISIX v3 (port 9180 par défaut, jamais exposé hors zone interne). */
export class ApisixAdminClient implements GatewayAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly adminKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async putConsumer(consumer: ApisixConsumer): Promise<void> {
    await this.call('PUT', '/apisix/admin/consumers', consumer);
  }

  async deleteConsumer(username: string): Promise<void> {
    await this.call('DELETE', `/apisix/admin/consumers/${encodeURIComponent(username)}`, undefined, true);
  }

  async putCredential(username: string, credentialId: string, plugins: Record<string, unknown>): Promise<void> {
    await this.call(
      'PUT',
      `/apisix/admin/consumers/${encodeURIComponent(username)}/credentials/${encodeURIComponent(credentialId)}`,
      { plugins, labels: { ...MANAGED_LABEL } },
    );
  }

  async putRoute(route: ApisixRoute): Promise<void> {
    const { id, ...body } = route;
    await this.call('PUT', `/apisix/admin/routes/${encodeURIComponent(id)}`, body);
  }

  async deleteRoute(id: string): Promise<void> {
    await this.call('DELETE', `/apisix/admin/routes/${encodeURIComponent(id)}`, undefined, true);
  }

  async listManagedConsumers(): Promise<string[]> {
    const items = await this.list('/apisix/admin/consumers');
    return items.filter(isManaged).map((v) => String(v.username));
  }

  async listManagedRoutes(): Promise<string[]> {
    const items = await this.list('/apisix/admin/routes');
    return items.filter(isManaged).map((v) => String(v.id));
  }

  private async list(path: string): Promise<Array<Record<string, any>>> {
    const body = (await this.call('GET', path)) as { list?: Array<{ value?: Record<string, any> }> } | undefined;
    return (body?.list ?? []).map((item) => item.value ?? {}).filter(Boolean);
  }

  private async call(method: string, path: string, body?: unknown, allowNotFound = false): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'X-API-KEY': this.adminKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allowNotFound && response.status === 404) return undefined;
    const text = await response.text();
    if (!response.ok) {
      throw new GatewayAdminError(`APISIX ${method} ${path} -> ${response.status} ${text.slice(0, 300)}`, response.status);
    }
    return text ? JSON.parse(text) : undefined;
  }
}

function isManaged(value: Record<string, any>): boolean {
  return value?.labels?.managed_by === MANAGED_LABEL.managed_by;
}

/** Implémentation en mémoire, pour les tests et le développement sans passerelle. */
export class InMemoryGatewayAdmin implements GatewayAdmin {
  readonly consumers = new Map<string, ApisixConsumer>();
  readonly credentials = new Map<string, Record<string, unknown>>();
  readonly routes = new Map<string, ApisixRoute>();

  async putConsumer(consumer: ApisixConsumer): Promise<void> {
    this.consumers.set(consumer.username, structuredClone(consumer));
  }
  async deleteConsumer(username: string): Promise<void> {
    this.consumers.delete(username);
    for (const key of [...this.credentials.keys()]) if (key.startsWith(`${username}/`)) this.credentials.delete(key);
  }
  async putCredential(username: string, credentialId: string, plugins: Record<string, unknown>): Promise<void> {
    if (!this.consumers.has(username)) throw new GatewayAdminError(`consumer ${username} inconnu`, 404);
    this.credentials.set(`${username}/${credentialId}`, structuredClone(plugins));
  }
  async putRoute(route: ApisixRoute): Promise<void> {
    this.routes.set(route.id, structuredClone(route));
  }
  async deleteRoute(id: string): Promise<void> {
    this.routes.delete(id);
  }
  async listManagedConsumers(): Promise<string[]> {
    return [...this.consumers.keys()];
  }
  async listManagedRoutes(): Promise<string[]> {
    return [...this.routes.keys()];
  }
}
