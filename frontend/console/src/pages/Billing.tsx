import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, Card, ErrorBanner, Field, formatAmount, formatDate, Loading, Pill, Table, toMillimes } from '@smt/ui';
import { useCan } from '../session';
import { PartnerRow, useList } from '../common';

interface Rec { statements: { id: string; bank: string; period: string; total: number; paid: number; balance: number; overpaid: number; status: string; dueDate: string; overdue: boolean }[]; unassigned: { id: string; bank: string; partnerId: string; amount: number; reference: string; receivedOn: string }[] }
const STATUS: Record<string, { text: string; tone?: 'ok' | 'warn' | 'danger' }> = { ISSUED: { text: 'Émis', tone: 'warn' }, PARTIAL: { text: 'Partiel', tone: 'warn' }, PAID: { text: 'Payé', tone: 'ok' } };

function lastMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** Relevés mensuels et rapprochement des paiements (F-FAC-01, F-FAC-02). */
export function Releves() {
  const can = useCan('finance');
  const qc = useQueryClient();
  const [period, setPeriod] = useState(lastMonth());
  const rec = useQuery({ queryKey: ['reconciliation', period], queryFn: () => api<Rec>(`/billing/reconciliation?period=${period}`) });
  const partners = useList<PartnerRow>('partners', '/partners');
  const refresh = () => qc.invalidateQueries({ queryKey: ['reconciliation'] });
  const generate = useMutation({ mutationFn: () => post<unknown[]>('/billing/statements/generate', { period }), onSuccess: refresh });
  const [pay, setPay] = useState({ partnerId: '', statementId: '', amount: '', reference: '', receivedOn: new Date().toISOString().slice(0, 10) });
  const record = useMutation({
    mutationFn: () => post('/billing/payments', { partnerId: pay.partnerId, ...(pay.statementId ? { statementId: pay.statementId } : {}), amount: toMillimes(pay.amount), reference: pay.reference, receivedOn: pay.receivedOn }),
    onSuccess: () => { setPay({ ...pay, amount: '', reference: '' }); refresh(); },
  });
  const assign = useMutation({ mutationFn: (v: { id: string; statementId: string }) => post(`/billing/payments/${v.id}/assign`, { statementId: v.statementId }), onSuccess: refresh });
  const sts = rec.data?.statements ?? [];
  return (
    <div className="stack">
      <h2>Relevés mensuels</h2>
      <div className="row">
        <Field label="Mois">{(p) => <input {...p} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />}</Field>
        {can && <button className="btn btn-primary" onClick={() => generate.mutate()} disabled={generate.isPending}>Émettre les relevés du mois</button>}
      </div>
      {generate.data && <div className="banner banner-ok" role="status">{generate.data.length} relevé(s) émis ; les banques déjà facturées pour ce mois sont inchangées.</div>}
      <ErrorBanner error={rec.error ?? generate.error} />
      {rec.isPending ? <Loading /> : (
        <Table caption="Relevés et rapprochement" rows={sts} rowKey={(s) => s.id} empty="Aucun relevé pour ce mois."
          columns={[
            { header: 'Banque', cell: (s) => <strong>{s.bank}</strong> },
            { header: 'Montant dû', cell: (s) => formatAmount(s.total) },
            { header: 'Payé', cell: (s) => formatAmount(s.paid) },
            { header: 'Reste', cell: (s) => formatAmount(s.balance) },
            { header: 'Écart', cell: (s) => (s.overpaid > 0 ? <Pill label={{ text: `Trop-perçu ${formatAmount(s.overpaid)}`, tone: 'warn' }} /> : '—') },
            { header: 'Échéance', cell: (s) => <>{formatDate(s.dueDate)}{s.overdue && <> <Pill label={{ text: 'En retard', tone: 'danger' }} /></>}</> },
            { header: 'État', cell: (s) => <Pill label={STATUS[s.status]} /> },
          ]} />
      )}
      {can && (
        <Card title="Enregistrer un paiement reçu">
          <form className="row" onSubmit={(e) => { e.preventDefault(); record.mutate(); }}>
            <Field label="Banque">{(p) => <select {...p} value={pay.partnerId} onChange={(e) => setPay({ ...pay, partnerId: e.target.value, statementId: '' })} required><option value="">Choisir…</option>{(partners.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select>}</Field>
            <Field label="Relevé">{(p) => <select {...p} value={pay.statementId} onChange={(e) => setPay({ ...pay, statementId: e.target.value })}><option value="">À rapprocher plus tard</option>{sts.filter((s) => s.bank === partners.data?.find((x) => x.id === pay.partnerId)?.code).map((s) => <option key={s.id} value={s.id}>{s.period} — {formatAmount(s.total)}</option>)}</select>}</Field>
            <Field label="Montant (TND)">{(p) => <input {...p} inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} required />}</Field>
            <Field label="Référence du virement">{(p) => <input {...p} value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} required />}</Field>
            <Field label="Reçu le">{(p) => <input {...p} type="date" value={pay.receivedOn} onChange={(e) => setPay({ ...pay, receivedOn: e.target.value })} required />}</Field>
            <button className="btn btn-primary" type="submit" disabled={record.isPending}>Enregistrer</button>
          </form>
          <ErrorBanner error={record.error} />
        </Card>
      )}
      {(rec.data?.unassigned ?? []).length > 0 && (
        <Card title="Paiements à rapprocher">
          <ErrorBanner error={assign.error} />
          <Table caption="Paiements non rapprochés" rows={rec.data!.unassigned} rowKey={(p) => p.id} empty="—"
            columns={[
              { header: 'Banque', cell: (p) => p.bank },
              { header: 'Montant', cell: (p) => formatAmount(p.amount) },
              { header: 'Référence', cell: (p) => <span className="mono">{p.reference}</span> },
              { header: 'Reçu le', cell: (p) => formatDate(p.receivedOn) },
              { header: 'Affecter au relevé', cell: (p) => can && <Field label={`Relevé pour ${p.reference}`}>{(f) => <select {...f} defaultValue="" onChange={(e) => e.target.value && assign.mutate({ id: p.id, statementId: e.target.value })}><option value="">Choisir…</option>{sts.filter((s) => s.bank === p.bank).map((s) => <option key={s.id} value={s.id}>{s.period} — reste {formatAmount(s.balance)}</option>)}</select>}</Field> },
            ]} />
        </Card>
      )}
    </div>
  );
}
