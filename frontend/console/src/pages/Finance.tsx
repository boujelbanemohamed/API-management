import { useState } from 'react';
import { ErrorBanner, Field, Kpi, Loading, monthBounds, PageHeader, Table } from '@smt/ui';
import { useList } from '../common';
import { Releves } from './Billing';

interface Row { partnerCode: string; apiSlug: string; calls: number; billable: number; errors: number; avgLatencyMs: number }

export function Facturation() {
  const [range, setRange] = useState(monthBounds());
  const q = useList<Row>('usage', `/usage/summary?from=${range.from}&to=${range.to}`);
  const rows = q.data ?? [];
  const sum = (k: 'calls' | 'billable' | 'errors') => rows.reduce((s, r) => s + r[k], 0).toLocaleString('fr-FR');
  return (
    <div className="stack">
      <PageHeader title="Facturation et rapprochement" subtitle="Consommation par banque et par service, relevés mensuels et paiements" />
      <Releves />
      <h2>Consommation</h2>
      <div className="row">
        <Field label="Du">{(p) => <input {...p} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="Au">{(p) => <input {...p} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
      </div>
      <ErrorBanner error={q.error} />
      {q.isPending ? <Loading /> : (
        <>
          <div className="grid grid-3"><Kpi label="Appels" value={sum('calls')} /><Kpi label="Facturables" value={sum('billable')} /><Kpi label="Erreurs" value={sum('errors')} /></div>
          <Table caption="Consommation" rows={rows} rowKey={(r) => r.partnerCode + r.apiSlug} empty="Aucun appel sur la période."
            columns={[
              { header: 'Banque', cell: (r) => <strong>{r.partnerCode}</strong> },
              { header: 'Service', cell: (r) => <span className="mono">{r.apiSlug}</span> },
              { header: 'Appels', cell: (r) => r.calls.toLocaleString('fr-FR') },
              { header: 'Facturables', cell: (r) => r.billable.toLocaleString('fr-FR') },
              { header: 'Erreurs', cell: (r) => r.errors.toLocaleString('fr-FR') },
            ]} />
        </>
      )}
    </div>
  );
}
