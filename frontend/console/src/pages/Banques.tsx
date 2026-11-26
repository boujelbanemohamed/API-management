import { useState } from 'react';
import { ErrorBanner, Field, formatDate, Loading, PageHeader, Pill, Table, ENVIRONMENT, SUBSCRIPTION_STATUS } from '@smt/ui';
import { useCan } from '../session';
import { ApiRow, askReason, PartnerRow, PlanRow, useAction, useList } from '../common';

const PARTNER_STATUS: Record<string, { text: string; tone?: 'ok' | 'warn' | 'danger' }> = {
  PENDING: { text: 'En cours d’intégration', tone: 'warn' }, ACTIVE: { text: 'Active', tone: 'ok' }, SUSPENDED: { text: 'Suspendue', tone: 'danger' }, TERMINATED: { text: 'Résiliée' },
};

export function Partenaires() {
  const can = useCan('banques');
  const q = useList<PartnerRow>('partners', '/partners');
  const act = useAction(['partners']);
  const [form, setForm] = useState({ code: '', name: '' });
  const [key, setKey] = useState<{ code: string; apiKey: string } | null>(null);
  const run = (p: PartnerRow, a: string, body?: unknown) => act.mutate({ path: `/partners/${p.id}/${a}`, body });
  const issueKey = async (p: PartnerRow) => {
    const r = (await act.mutateAsync({ path: `/partners/${p.id}/api-key` })) as { apiKey: string };
    setKey({ code: p.code, apiKey: r.apiKey });
  };
  return (
    <div className="stack">
      <PageHeader title="Partenaires" subtitle="Banques et établissements raccordés à la plateforme" />
      {key && <div className="banner banner-ok" role="status">Clé d’API de {key.code}, affichée une seule fois : <span className="mono">{key.apiKey}</span> <button className="btn btn-secondary" onClick={() => setKey(null)}>Masquer</button></div>}
      <ErrorBanner error={q.error ?? act.error} />
      {can && (
        <form className="card row" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: '/partners', body: form }); setForm({ code: '', name: '' }); }}>
          <Field label="Code">{(p) => <input {...p} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />}</Field>
          <Field label="Raison sociale">{(p) => <input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />}</Field>
          <button className="btn btn-primary" type="submit">Ajouter la banque</button>
        </form>
      )}
      {q.isPending ? <Loading /> : (
        <Table caption="Partenaires" rows={q.data ?? []} rowKey={(p) => p.id} empty="Aucune banque."
          columns={[
            { header: 'Code', cell: (p) => <strong>{p.code}</strong> },
            { header: 'Nom', cell: (p) => p.name },
            { header: 'État', cell: (p) => <Pill label={PARTNER_STATUS[p.status]} /> },
            {
              header: 'Actions',
              cell: (p) => can && p.status !== 'TERMINATED' && (
                <div className="row">
                  {p.status !== 'ACTIVE' && <button className="btn btn-secondary" onClick={() => run(p, 'activate')}>Activer</button>}
                  {p.status === 'ACTIVE' && <button className="btn btn-secondary" onClick={() => { const reason = askReason(`Motif de la suspension de ${p.code}`); if (reason) run(p, 'suspend', { reason }); }}>Suspendre</button>}
                  <button className="btn btn-secondary" onClick={() => issueKey(p)}>Nouvelle clé d’API</button>
                </div>
              ),
            },
          ]} />
      )}
    </div>
  );
}

interface SubRow { id: string; partnerId: string; apiId: string; planId: string; environment: string; status: string; startDate: string; endDate: string | null }

export function Abonnements() {
  const can = useCan('banques');
  const q = useList<SubRow>('subscriptions', '/subscriptions');
  const partners = useList<PartnerRow>('partners', '/partners');
  const apis = useList<ApiRow>('apis', '/apis');
  const plans = useList<PlanRow>('plans', '/plans');
  const act = useAction(['subscriptions']);
  const name = <T extends { id: string }>(list: T[] | undefined, id: string, f: (x: T) => string) => { const x = list?.find((i) => i.id === id); return x ? f(x) : '…'; };
  const run = (s: SubRow, a: string, body?: unknown) => act.mutate({ path: `/subscriptions/${s.id}/${a}`, body });
  return (
    <div className="stack">
      <PageHeader title="Abonnements" subtitle="La production exige une mise en service validée (PV signé par la banque et SMT)" />
      <ErrorBanner error={q.error ?? act.error} />
      {q.isPending ? <Loading /> : (
        <Table caption="Abonnements" rows={q.data ?? []} rowKey={(s) => s.id} empty="Aucun abonnement."
          columns={[
            { header: 'Banque', cell: (s) => name(partners.data, s.partnerId, (p) => p.code) },
            { header: 'Service', cell: (s) => name(apis.data, s.apiId, (a) => a.name) },
            { header: 'Plan', cell: (s) => name(plans.data, s.planId, (p) => p.name) },
            { header: 'Environnement', cell: (s) => ENVIRONMENT[s.environment] },
            { header: 'État', cell: (s) => <Pill label={SUBSCRIPTION_STATUS[s.status]} /> },
            { header: 'Période', cell: (s) => `${formatDate(s.startDate)} → ${formatDate(s.endDate)}` },
            {
              header: 'Actions',
              cell: (s) => can && (
                <div className="row">
                  {s.status === 'PENDING' && <><button className="btn btn-primary" onClick={() => run(s, 'validate')}>Valider</button><button className="btn btn-secondary" onClick={() => { const reason = askReason('Motif du refus'); if (reason) run(s, 'reject', { reason }); }}>Refuser</button></>}
                  {s.status === 'ACTIVE' && <button className="btn btn-secondary" onClick={() => { const reason = askReason('Motif de la suspension'); if (reason) run(s, 'suspend', { reason }); }}>Suspendre</button>}
                  {s.status === 'SUSPENDED' && <button className="btn btn-secondary" onClick={() => run(s, 'reactivate')}>Réactiver</button>}
                </div>
              ),
            },
          ]} />
      )}
    </div>
  );
}
