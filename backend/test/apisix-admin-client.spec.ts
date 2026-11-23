import { ApisixAdminClient, GatewayAdminError } from '../src/gateway/gateway-admin';

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('Client de l’API d’administration APISIX', () => {
  it('envoie les routes en PUT avec la clé d’administration', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: {} }]);
    const client = new ApisixAdminClient('http://apisix:9180/', 'secret', fn);
    await client.putRoute({ id: 'transactions-v1', name: 'x', uris: ['/t'], status: 1, labels: {}, upstream: {} as any, plugins: {} });
    expect(calls[0].url).toBe('http://apisix:9180/apisix/admin/routes/transactions-v1');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>)['X-API-KEY']).toBe('secret');
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('id');
  });

  it('ne liste que les objets gérés par la plateforme', async () => {
    const { fn } = fakeFetch([
      {
        status: 200,
        body: {
          total: 2,
          list: [
            { value: { id: 'transactions-v1', labels: { managed_by: 'api-platform' } } },
            { value: { id: 'route-manuelle', labels: {} } },
          ],
        },
      },
    ]);
    expect(await new ApisixAdminClient('http://a', 'k', fn).listManagedRoutes()).toEqual(['transactions-v1']);
  });

  it('ignore les 404 à la suppression et remonte les autres erreurs', async () => {
    const { fn } = fakeFetch([{ status: 404 }, { status: 500, body: { error_msg: 'boom' } }]);
    const client = new ApisixAdminClient('http://a', 'k', fn);
    await expect(client.deleteRoute('absente')).resolves.toBeUndefined();
    await expect(client.deleteRoute('x')).rejects.toBeInstanceOf(GatewayAdminError);
  });
});
