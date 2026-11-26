import { useState } from 'react';
import { ErrorBanner, Field, Loading, PageHeader, Pill, Table } from '@smt/ui';
import { useCan } from '../session';
import { ApiRow, PlanRow, ProviderRow, useAction, useList } from '../common';

const API_STATUS: Record<string, { text: string; tone?: 'ok' | 'warn' | 'danger' | 'info' }> = {
  DRAFT: { text: 'Brouillon' }, BETA: { text: 'Bêta (sandbox)', tone: 'info' }, PUBLISHED: { text: 'Publié', tone: 'ok' }, DEPRECATED: { text: 'Obsolète', tone: 'warn' }, RETIRED: { text: 'Retiré', tone: 'danger' },
};
const NEXT_STATUS: Record<string, string[]> = { DRAFT: ['BETA', 'PUBLISHED'], BETA: ['PUBLISHED', 'DRAFT'], PUBLISHED: ['DEPRECATED'], DEPRECATED: ['RETIRED', 'PUBLISHED'], RETIRED: [] };

export function ApiProduits() {
  const can = useCan('catalogue');
  const q = useList<ApiRow>('apis', '/apis');
  const providers = useList<ProviderRow>('providers', '/providers');
  const act = useAction(['apis']);
  const empty = { name: '', slug: '', publicPath: '', upstreamPath: '', providerId: '', description: '' };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="stack">
      <PageHeader title="API et produits" subtitle="Publier un service = le rendre visible aux banques ; la passerelle est mise à jour automatiquement" />
      <ErrorBanner error={q.error ?? act.error} />
      {can && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: '/apis', body: { ...f, description: f.description || undefined } }); setF(empty); }}>
          <h2>Nouveau service</h2>
          <div className="grid grid-3">
            <Field label="Nom">{(p) => <input {...p} value={f.name} onChange={set('name')} required />}</Field>
            <Field label="Identifiant (slug)" hint="minuscules, chiffres, tirets">{(p) => <input {...p} value={f.slug} onChange={set('slug')} required />}</Field>
            <Field label="Fournisseur">{(p) => <select {...p} value={f.providerId} onChange={set('providerId')} required><option value="">Choisir…</option>{(providers.data ?? []).map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}</select>}</Field>
            <Field label="Chemin public" hint="ex. /cartes/v1">{(p) => <input {...p} value={f.publicPath} onChange={set('publicPath')} required />}</Field>
            <Field label="Chemin chez le fournisseur">{(p) => <input {...p} value={f.upstreamPath} onChange={set('upstreamPath')} required />}</Field>
            <Field label="Description">{(p) => <input {...p} value={f.description} onChange={set('description')} />}</Field>
          </div>
          <div><button className="btn btn-primary" type="submit">Créer le service</button></div>
        </form>
      )}
      {q.isPending ? <Loading /> : (
        <Table caption="Services" rows={q.data ?? []} rowKey={(a) => a.id} empty="Aucun service."
          columns={[
            { header: 'Service', cell: (a) => <><strong>{a.name}</strong> <span className="mono">{a.slug}</span></> },
            { header: 'Chemins', cell: (a) => <span className="mono">{a.publicPath} → {a.upstreamPath}</span> },
            { header: 'Fournisseur', cell: (a) => providers.data?.find((p) => p.id === a.providerId)?.name ?? '…' },
            { header: 'État', cell: (a) => <Pill label={API_STATUS[a.status]} /> },
            { header: 'Changer l’état', cell: (a) => can && <div className="row">{(NEXT_STATUS[a.status] ?? []).map((s) => <button key={s} className="btn btn-secondary" onClick={() => act.mutate({ path: `/apis/${a.id}/status`, body: { status: s } })}>{API_STATUS[s].text}</button>)}</div> },
          ]} />
      )}
    </div>
  );
}

export function Plans() {
  const can = useCan('catalogue');
  const q = useList<PlanRow>('plans', '/plans');
  const act = useAction(['plans']);
  const [f, setF] = useState({ name: '', dailyQuota: '1000', rateLimitPerSecond: '10' });
  return (
    <div className="stack">
      <PageHeader title="Plans" subtitle="Quotas journaliers et débit maximal appliqués par la passerelle" />
      <ErrorBanner error={q.error ?? act.error} />
      {can && (
        <form className="card row" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: '/plans', body: { name: f.name, dailyQuota: Number(f.dailyQuota), rateLimitPerSecond: Number(f.rateLimitPerSecond) } }); }}>
          <Field label="Nom">{(p) => <input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
          <Field label="Quota par jour">{(p) => <input {...p} type="number" min={1} value={f.dailyQuota} onChange={(e) => setF({ ...f, dailyQuota: e.target.value })} required />}</Field>
          <Field label="Débit (requêtes/s)">{(p) => <input {...p} type="number" min={1} value={f.rateLimitPerSecond} onChange={(e) => setF({ ...f, rateLimitPerSecond: e.target.value })} required />}</Field>
          <button className="btn btn-primary" type="submit">Créer le plan</button>
        </form>
      )}
      {q.isPending ? <Loading /> : (
        <Table caption="Plans" rows={q.data ?? []} rowKey={(p) => p.id} empty="Aucun plan."
          columns={[
            { header: 'Plan', cell: (p) => <strong>{p.name}</strong> },
            { header: 'Quota par jour', cell: (p) => p.dailyQuota.toLocaleString('fr-FR') },
            { header: 'Débit', cell: (p) => `${p.rateLimitPerSecond} req/s` },
            { header: 'Validation', cell: (p) => (p.approval === 'AUTO' ? 'Automatique' : 'Manuelle') },
            { header: 'Actif', cell: (p) => (p.active ? 'Oui' : 'Non') },
          ]} />
      )}
    </div>
  );
}

export function Fournisseurs() {
  const can = useCan('catalogue');
  const q = useList<ProviderRow>('providers', '/providers');
  const act = useAction(['providers']);
  const [f, setF] = useState({ name: '', baseUrl: '', sandboxBaseUrl: '' });
  return (
    <div className="stack">
      <PageHeader title="Fournisseurs" subtitle="Jamais visibles des banques. En sandbox, les appels vont vers le simulateur." />
      <ErrorBanner error={q.error ?? act.error} />
      {can && (
        <form className="card row" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: '/providers', body: { name: f.name, baseUrl: f.baseUrl, sandboxBaseUrl: f.sandboxBaseUrl || undefined } }); }}>
          <Field label="Nom">{(p) => <input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />}</Field>
          <Field label="Adresse de production">{(p) => <input {...p} type="url" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} required />}</Field>
          <Field label="Adresse du simulateur (sandbox)">{(p) => <input {...p} type="url" value={f.sandboxBaseUrl} onChange={(e) => setF({ ...f, sandboxBaseUrl: e.target.value })} />}</Field>
          <button className="btn btn-primary" type="submit">Ajouter</button>
        </form>
      )}
      {q.isPending ? <Loading /> : (
        <Table caption="Fournisseurs" rows={q.data ?? []} rowKey={(p) => p.id} empty="Aucun fournisseur."
          columns={[
            { header: 'Nom', cell: (p) => <strong>{p.name}</strong> },
            { header: 'Production', cell: (p) => <span className="mono">{p.baseUrl}</span> },
            { header: 'Sandbox', cell: (p) => <span className="mono">{p.sandboxBaseUrl ?? '—'}</span> },
          ]} />
      )}
    </div>
  );
}
