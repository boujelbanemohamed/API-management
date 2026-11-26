import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorBanner, Field, formatDate, Kpi, Loading, monthBounds, PageHeader, Pill, Table, ENVIRONMENT, SUBSCRIPTION_STATUS } from '@smt/ui';
import type { CatalogueItem, Subscription, UsageRow } from '../types';

export function Consommation() {
  const [range, setRange] = useState(monthBounds());
  const usage = useQuery({ queryKey: ['usage', range], queryFn: () => api<UsageRow[]>(`/portal/usage/summary?from=${range.from}&to=${range.to}`) });
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: () => api<Subscription[]>('/portal/subscriptions') });
  const cat = useQuery({ queryKey: ['catalogue'], queryFn: () => api<CatalogueItem[]>('/portal/catalogue'), retry: false });
  const rows = usage.data ?? [];
  const total = (k: keyof UsageRow) => rows.reduce((s, r) => s + Number(r[k]), 0);
  const apiName = (id: string) => cat.data?.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="stack">
      <PageHeader title="Consommation et facturation" subtitle="Appels comptés par la passerelle : base des relevés mensuels" />
      <div className="row">
        <Field label="Du">{(p) => <input {...p} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="Au">{(p) => <input {...p} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
      </div>
      <ErrorBanner error={usage.error} />
      {usage.isPending ? <Loading /> : (
        <>
          <div className="grid grid-3">
            <Kpi label="Appels" value={total('calls').toLocaleString('fr-FR')} />
            <Kpi label="Appels facturables" value={total('billable').toLocaleString('fr-FR')} />
            <Kpi label="Erreurs" value={total('errors').toLocaleString('fr-FR')} />
          </div>
          <Table
            caption="Consommation par service"
            rows={rows}
            rowKey={(r) => r.apiSlug}
            empty="Aucun appel sur la période."
            columns={[
              { header: 'Service', cell: (r) => <span className="mono">{r.apiSlug}</span> },
              { header: 'Appels', cell: (r) => r.calls.toLocaleString('fr-FR') },
              { header: 'Facturables', cell: (r) => r.billable.toLocaleString('fr-FR') },
              { header: 'Erreurs', cell: (r) => r.errors.toLocaleString('fr-FR') },
              { header: 'Latence moyenne', cell: (r) => `${Math.round(r.avgLatencyMs)} ms` },
            ]}
          />
        </>
      )}
      <h2>Abonnements</h2>
      <ErrorBanner error={subs.error} />
      <Table
        caption="Abonnements"
        rows={subs.data ?? []}
        rowKey={(s) => s.id}
        empty="Aucun abonnement."
        columns={[
          { header: 'Service', cell: (s) => apiName(s.apiId) },
          { header: 'Environnement', cell: (s) => ENVIRONMENT[s.environment] ?? s.environment },
          { header: 'État', cell: (s) => <Pill label={SUBSCRIPTION_STATUS[s.status]} /> },
          { header: 'Du', cell: (s) => formatDate(s.startDate) },
          { header: 'Au', cell: (s) => formatDate(s.endDate) },
        ]}
      />
    </div>
  );
}
