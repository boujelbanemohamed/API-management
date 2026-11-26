import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  api, post, Card, ErrorBanner, Field, formatAmount, formatDate, Loading, MASKED_PAN, PageHeader, Pill, Table, toMillimes,
  DISPUTE_ACTION, DISPUTE_STAGE, DELIVERY,
} from '@smt/ui';
import { useCan, useMe } from '../session';
import type { Dispute } from '../types';

/** Qui doit agir à chaque étape (même règle que le back-end, dispute-rules.ts). */
const TURN: Record<string, 'ISSUER' | 'ACQUIRER' | 'SMT'> = {
  OPENED: 'ISSUER', INFO_PROVIDED: 'ISSUER', SECOND_PRESENTMENT: 'ISSUER',
  INFO_REQUESTED: 'ACQUIRER', CHARGEBACK: 'ACQUIRER', SECOND_CHARGEBACK: 'ACQUIRER',
  ARBITRATION_REQUESTED: 'SMT',
};
const NEXT: Record<string, string[]> = {
  OPENED: ['info-request', 'chargeback'],
  INFO_REQUESTED: ['info-response'],
  INFO_PROVIDED: ['chargeback', 'accept'],
  CHARGEBACK: ['second-presentment', 'accept'],
  SECOND_PRESENTMENT: ['second-chargeback', 'accept'],
  SECOND_CHARGEBACK: ['arbitration-request', 'accept'],
};
const WITH_AMOUNT = ['chargeback', 'second-presentment', 'second-chargeback'];

export function roleOf(d: Dispute, partnerId: string): 'ISSUER' | 'ACQUIRER' {
  return d.issuerId === partnerId ? 'ISSUER' : 'ACQUIRER';
}
export function myTurn(d: Dispute, partnerId: string): boolean {
  const t = TURN[d.stage];
  return (t === 'ISSUER' && d.issuerId === partnerId) || (t === 'ACQUIRER' && d.acquirerId === partnerId);
}

export function LitigesListe() {
  const me = useMe();
  const can = useCan('litiges');
  const q = useQuery({ queryKey: ['disputes'], queryFn: () => api<Dispute[]>('/portal/disputes') });
  return (
    <div className="stack">
      <PageHeader
        title="Litiges"
        subtitle="Scheme national : vos litiges en tant qu’émetteur ou acquéreur"
        actions={can && <Link className="btn btn-primary" to="/litiges/nouveau">Ouvrir un litige</Link>}
      />
      <ErrorBanner error={q.error} />
      {q.isPending ? <Loading /> : (
        <Table
          caption="Liste des litiges"
          rows={q.data ?? []}
          rowKey={(d) => d.id}
          empty="Aucun litige."
          columns={[
            { header: 'Transaction', cell: (d) => <Link to={`/litiges/${d.id}`}>{d.transactionRef}</Link> },
            { header: 'Carte', cell: (d) => <span className="mono">{d.maskedPan}</span> },
            { header: 'Votre rôle', cell: (d) => (roleOf(d, me.partner.id) === 'ISSUER' ? 'Émetteur' : 'Acquéreur') },
            { header: 'Montant', cell: (d) => formatAmount(d.transactionAmount) },
            { header: 'Étape', cell: (d) => <Pill label={DISPUTE_STAGE[d.stage]} /> },
            { header: 'Échéance', cell: (d) => (myTurn(d, me.partner.id) ? <strong>{formatDate(d.deadline)} — à vous</strong> : formatDate(d.deadline)) },
          ]}
        />
      )}
    </div>
  );
}

const openSchema = z.object({
  acquirerCode: z.string().trim().regex(/^[A-Za-z0-9_]{2,40}$/, 'Code de banque invalide'),
  transactionRef: z.string().trim().min(1, 'Référence obligatoire').max(40),
  maskedPan: z.string().trim().regex(MASKED_PAN, 'Format masqué attendu : 6 premiers chiffres, astérisques, 4 derniers (ex. 412345******2345)'),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date obligatoire'),
  amount: z.string().trim().regex(/^\d+([.,]\d{1,3})?$/, 'Montant en dinars, ex. 125,500'),
  reasonCode: z.string().trim().min(1, 'Code motif obligatoire').max(10),
});
type OpenForm = z.infer<typeof openSchema>;

export function LitigeNouveau() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Préremplissage depuis l'écran Transactions (F-LIT-01).
  const [params] = useSearchParams();
  const { register, handleSubmit, formState } = useForm<OpenForm>({
    resolver: zodResolver(openSchema),
    defaultValues: {
      transactionRef: params.get('reference') ?? '',
      maskedPan: params.get('pan') ?? '',
      transactionDate: params.get('date') ?? '',
      amount: params.get('amount') ?? '',
      acquirerCode: params.get('acquirer') ?? '',
      reasonCode: '',
    },
  });
  const open = useMutation({
    mutationFn: (f: OpenForm) =>
      post<Dispute>('/portal/disputes', {
        acquirerCode: f.acquirerCode, transactionRef: f.transactionRef, maskedPan: f.maskedPan,
        transactionDate: f.transactionDate, transactionAmount: toMillimes(f.amount), reasonCode: f.reasonCode,
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['disputes'] });
      navigate(`/litiges/${d.id}`);
    },
  });
  const e = formState.errors;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <PageHeader title="Ouvrir un litige" subtitle="Vous êtes la banque émettrice. Le litige doit être ouvert dans les 120 jours suivant la transaction." />
      <form className="card stack" onSubmit={handleSubmit((f) => open.mutate(f))} noValidate>
        <Field label="Référence de la transaction" error={e.transactionRef?.message}>{(p) => <input {...p} {...register('transactionRef')} />}</Field>
        <Field label="Numéro de carte masqué" hint="Jamais le numéro complet" error={e.maskedPan?.message}>{(p) => <input {...p} {...register('maskedPan')} autoComplete="off" />}</Field>
        <div className="grid grid-3">
          <Field label="Date de la transaction" error={e.transactionDate?.message}>{(p) => <input {...p} type="date" {...register('transactionDate')} />}</Field>
          <Field label="Montant (TND)" error={e.amount?.message}>{(p) => <input {...p} inputMode="decimal" {...register('amount')} />}</Field>
          <Field label="Code motif" error={e.reasonCode?.message}>{(p) => <input {...p} {...register('reasonCode')} />}</Field>
        </div>
        <Field label="Code de la banque acquéreuse" hint="Ex. STB" error={e.acquirerCode?.message}>{(p) => <input {...p} {...register('acquirerCode')} />}</Field>
        <ErrorBanner error={open.error} />
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={open.isPending}>Ouvrir le litige</button>
          <Link className="btn btn-secondary" to="/litiges">Annuler</Link>
        </div>
      </form>
    </div>
  );
}

export function LitigeDetail() {
  const { id } = useParams();
  const me = useMe();
  const can = useCan('litiges');
  const qc = useQueryClient();
  const [action, setAction] = useState('');
  const [amount, setAmount] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const q = useQuery({ queryKey: ['disputes', 'one', id], queryFn: () => api<Dispute>(`/portal/disputes/${id}`) });
  const act = useMutation({
    mutationFn: () =>
      post<Dispute>(`/portal/disputes/${id}/actions`, {
        action,
        ...(WITH_AMOUNT.includes(action) && amount ? { amount: toMillimes(amount) } : {}),
        ...(documentRef ? { documentRef } : {}),
      }),
    onSuccess: () => {
      setAction(''); setAmount(''); setDocumentRef('');
      qc.invalidateQueries({ queryKey: ['disputes'] });
    },
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const d = q.data;
  const role = roleOf(d, me.partner.id);
  const actions = myTurn(d, me.partner.id) ? NEXT[d.stage] ?? [] : [];
  return (
    <div className="stack" style={{ maxWidth: 960 }}>
      <PageHeader title={`Litige — transaction ${d.transactionRef}`} subtitle={`Vous êtes ${role === 'ISSUER' ? 'émetteur' : 'acquéreur'}`} actions={<Pill label={DISPUTE_STAGE[d.stage]} />} />
      <Card title="Transaction">
        <dl className="details">
          <dt>Carte</dt><dd className="mono">{d.maskedPan}</dd>
          <dt>Date</dt><dd>{formatDate(d.transactionDate)}</dd>
          <dt>Montant</dt><dd>{formatAmount(d.transactionAmount)}</dd>
          <dt>Montant contesté</dt><dd>{formatAmount(d.disputedAmount ?? d.transactionAmount)}</dd>
          <dt>Code motif</dt><dd>{d.reasonCode}</dd>
          <dt>Prochaine échéance</dt><dd>{formatDate(d.deadline)}</dd>
          {d.winner && <><dt>Gagnant</dt><dd>{d.winner === role ? 'Votre banque' : 'L’autre banque'}</dd></>}
        </dl>
      </Card>
      {can && actions.length > 0 && (
        <Card title="C’est à vous d’agir">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate(); }}>
            <Field label="Action">
              {(p) => (
                <select {...p} value={action} onChange={(e) => setAction(e.target.value)} required>
                  <option value="">Choisir…</option>
                  {actions.map((a) => <option key={a} value={a}>{DISPUTE_ACTION[a]}</option>)}
                </select>
              )}
            </Field>
            {WITH_AMOUNT.includes(action) && (
              <Field label="Montant contesté (TND)" hint="Vide = montant total. Un montant inférieur produit un message partiel.">
                {(p) => <input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Field>
            )}
            {action && action !== 'accept' && (
              <Field label="Référence du justificatif" hint={action === 'second-chargeback' ? 'Obligatoire : un nouveau justificatif' : 'Facultatif'}>
                {(p) => <input {...p} value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} required={action === 'second-chargeback'} />}
              </Field>
            )}
            <ErrorBanner error={act.error} />
            <div><button className="btn btn-primary" type="submit" disabled={!action || act.isPending}>Valider l’action</button></div>
          </form>
        </Card>
      )}
      <Card title="Historique">
        {(d.events ?? []).length === 0 ? <p className="kpi-label">Aucune action pour l’instant.</p> : (
          <ol className="timeline">
            {(d.events ?? []).map((ev) => (
              <li key={ev.id}>
                <strong>{DISPUTE_ACTION[ev.action] ?? ev.action}</strong> — {formatDate(ev.occurredOn)} par {ev.actor}
                {ev.mti && <> · message <span className="mono">{ev.mti}/{ev.functionCode}</span> <Pill label={DELIVERY[ev.deliveryStatus ?? '']} /></>}
                {ev.amount !== null && <> · {formatAmount(ev.amount)}</>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
