import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, Card, ErrorBanner, Field, formatAmount, formatDate, Loading, PageHeader, Pill, Table, toMillimes, DISPUTE_ACTION, DISPUTE_STAGE } from '@smt/ui';
import { useHasRole } from '../session';
import { useAction, useList } from '../common';

interface Dispute { id: string; issuerId: string; acquirerId: string; transactionRef: string; maskedPan: string; transactionDate: string; transactionAmount: number; disputedAmount: number | null; reasonCode: string; stage: string; deadline: string | null; winner: string | null; arbitrationFees: number | null; events?: { id: string; action: string; party: string; actor: string; occurredOn: string; mti: string | null; functionCode: string | null }[] }

function usePartnerCode() {
  const partners = useList<{ id: string; code: string }>('partners', '/partners');
  return (id: string) => partners.data?.find((p) => p.id === id)?.code ?? '…';
}

export function LitigesConsole() {
  const [stage, setStage] = useState('');
  const q = useList<Dispute>('disputes', `/disputes${stage ? `?stage=${stage}` : ''}`);
  const code = usePartnerCode();
  return (
    <div className="stack">
      <PageHeader title="Litiges" subtitle="Scheme national : suivi de tous les litiges et séances d’arbitrage" />
      <Field label="Étape">{(p) => <select {...p} value={stage} onChange={(e) => setStage(e.target.value)}><option value="">Toutes</option>{Object.entries(DISPUTE_STAGE).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</select>}</Field>
      <ErrorBanner error={q.error} />
      {q.isPending ? <Loading /> : (
        <Table caption="Litiges" rows={q.data ?? []} rowKey={(d) => d.id} empty="Aucun litige."
          columns={[
            { header: 'Transaction', cell: (d) => <Link to={`/litiges/${d.id}`}>{d.transactionRef}</Link> },
            { header: 'Émetteur', cell: (d) => code(d.issuerId) },
            { header: 'Acquéreur', cell: (d) => code(d.acquirerId) },
            { header: 'Montant', cell: (d) => formatAmount(d.disputedAmount ?? d.transactionAmount) },
            { header: 'Étape', cell: (d) => <Pill label={DISPUTE_STAGE[d.stage]} /> },
            { header: 'Échéance', cell: (d) => formatDate(d.deadline) },
          ]} />
      )}
    </div>
  );
}

export function LitigeConsoleDetail() {
  const { id } = useParams();
  const isArbiter = useHasRole('console-arbitre');
  const code = usePartnerCode();
  const q = useQuery({ queryKey: ['disputes', 'one', id], queryFn: () => api<Dispute>(`/disputes/${id}`) });
  const decide = useAction(['disputes']);
  const [winner, setWinner] = useState('');
  const [fees, setFees] = useState('');
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const d = q.data;
  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <PageHeader title={`Litige — ${d.transactionRef}`} subtitle={`${code(d.issuerId)} (émetteur) contre ${code(d.acquirerId)} (acquéreur)`} actions={<Pill label={DISPUTE_STAGE[d.stage]} />} />
      <Card title="Transaction">
        <dl className="details">
          <dt>Carte</dt><dd className="mono">{d.maskedPan}</dd>
          <dt>Date</dt><dd>{formatDate(d.transactionDate)}</dd>
          <dt>Montant contesté</dt><dd>{formatAmount(d.disputedAmount ?? d.transactionAmount)}</dd>
          <dt>Code motif</dt><dd>{d.reasonCode}</dd>
          {d.winner && <><dt>Décision</dt><dd>En faveur de {d.winner === 'ISSUER' ? code(d.issuerId) : code(d.acquirerId)}{d.arbitrationFees ? ` · frais ${formatAmount(d.arbitrationFees)}` : ''}</dd></>}
        </dl>
      </Card>
      {d.stage === 'ARBITRATION_REQUESTED' && (
        <Card title="Décision d’arbitrage">
          {isArbiter ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); decide.mutate({ path: `/disputes/${id}/decision`, body: { winner, ...(fees ? { fees: toMillimes(fees) } : {}) } }); }}>
              <Field label="Décision en faveur de">{(p) => <select {...p} value={winner} onChange={(e) => setWinner(e.target.value)} required><option value="">Choisir…</option><option value="ISSUER">{code(d.issuerId)} (émetteur)</option><option value="ACQUIRER">{code(d.acquirerId)} (acquéreur)</option></select>}</Field>
              <Field label="Frais d’arbitrage (TND)" hint="Message de frais 1740 envoyé si un montant est saisi">{(p) => <input {...p} inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} />}</Field>
              <ErrorBanner error={decide.error} />
              <div><button className="btn btn-primary" type="submit" disabled={!winner || decide.isPending}>Rendre la décision</button></div>
            </form>
          ) : <div className="banner banner-info">Décision réservée à l’arbitre.</div>}
        </Card>
      )}
      <Card title="Historique et messages ISO">
        <ol className="timeline">
          {(d.events ?? []).map((ev) => (
            <li key={ev.id}><strong>{DISPUTE_ACTION[ev.action] ?? ev.action}</strong> — {formatDate(ev.occurredOn)} · {ev.actor}{ev.mti && <> · <span className="mono">{ev.mti}/{ev.functionCode}</span></>}</li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
