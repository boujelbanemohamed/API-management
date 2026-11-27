import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorBanner, Field, formatAmount, formatDate, Kpi, Loading, monthBounds, PageHeader, Pill, Table, ENVIRONMENT, SUBSCRIPTION_STATUS } from '@smt/ui';

interface StatementRow { id: string; period: string; total: number; paid: number; status: string; issuedOn: string; dueDate: string; lines: { kind: string; label: string; quantity: number; unitPrice: number; amount: number }[] }
const ST_STATUS: Record<string, { text: string; tone?: 'ok' | 'warn' | 'danger' }> = { ISSUED: { text: 'À régler', tone: 'warn' }, PARTIAL: { text: 'Partiellement réglé', tone: 'warn' }, PAID: { text: 'Réglé', tone: 'ok' } };
import type { CatalogueItem, Subscription, UsageRow } from '../types';

export function Consommation() {
  const [range, setRange] = useState(monthBounds());
  const usage = useQuery({ queryKey: ['usage', range], queryFn: () => api<UsageRow[]>(`/portal/usage/summary?from=${range.from}&to=${range.to}`) });
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: () => api<Subscription[]>('/portal/subscriptions') });
  const cat = useQuery({ queryKey: ['catalogue'], queryFn: () => api<CatalogueItem[]>('/portal/catalogue'), retry: false });
  const statements = useQuery({ queryKey: ['statements'], queryFn: () => api<StatementRow[]>('/portal/statements') });
  const [open, setOpen] = useState<string | null>(null);
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
      <h2>Relevés mensuels</h2>
      <ErrorBanner error={statements.error} />
      {statements.isPending ? <Loading /> : (statements.data ?? []).length === 0 ? <p className="kpi-label">Aucun relevé émis.</p> : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Relevés</caption>
            <thead><tr><th scope="col">Mois</th><th scope="col">Montant</th><th scope="col">Réglé</th><th scope="col">Échéance</th><th scope="col">État</th><th scope="col">Détail</th></tr></thead>
            <tbody>
              {(statements.data ?? []).map((s) => (
                <Fragment key={s.id}>
                  <tr>
                    <td>{s.period}</td><td>{formatAmount(s.total)}</td><td>{formatAmount(s.paid)}</td><td>{formatDate(s.dueDate)}</td>
                    <td><Pill label={ST_STATUS[s.status]} /></td>
                    <td><button className="btn btn-secondary" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Masquer' : 'Voir les lignes'}</button></td>
                  </tr>
                  {open === s.id && (
                    <tr><td colSpan={6}>
                      <ul style={{ margin: 0 }}>{s.lines.map((l, i) => <li key={i}>{l.label} : {l.quantity.toLocaleString('fr-FR')} × {formatAmount(l.unitPrice)} = <strong>{formatAmount(l.amount)}</strong></li>)}</ul>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
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
