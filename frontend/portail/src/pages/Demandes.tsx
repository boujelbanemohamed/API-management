import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  api, post, Card, ErrorBanner, Field, formatDate, FULL_PAN, Loading, PageHeader, Pill, Table,
  REQUEST_STATUS, REQUEST_TYPE, SLA, OPERATION_SERVICE,
} from '@smt/ui';
import { useCan } from '../session';
import type { ServiceRequest } from '../types';

export function DemandesListe() {
  const can = useCan('demandes');
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['requests', status], queryFn: () => api<ServiceRequest[]>(`/portal/requests${status ? `?status=${status}` : ''}`) });
  return (
    <div className="stack">
      <PageHeader
        title="Mes demandes"
        subtitle="Opérations, accès API, IP et certificats, support : suivi et délais d’engagement"
        actions={can && <Link className="btn btn-primary" to="/demandes/nouvelle">Nouvelle demande</Link>}
      />
      <div className="row">
        <Field label="Filtrer par état">
          {(p) => (
            <select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tous les états</option>
              {Object.entries(REQUEST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}
            </select>
          )}
        </Field>
      </div>
      <ErrorBanner error={q.error} />
      {q.isPending ? <Loading /> : (
        <Table
          caption="Liste des demandes"
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          empty="Aucune demande."
          columns={[
            { header: 'Objet', cell: (r) => <Link to={`/demandes/${r.id}`}>{r.subject}</Link> },
            { header: 'Type', cell: (r) => REQUEST_TYPE[r.type] ?? r.type },
            { header: 'Ouverte le', cell: (r) => formatDate(r.openedOn) },
            { header: 'Échéance', cell: (r) => formatDate(r.dueDate) },
            { header: 'État', cell: (r) => <Pill label={REQUEST_STATUS[r.status]} /> },
            { header: 'Délai', cell: (r) => <Pill label={SLA[r.sla]} /> },
          ]}
        />
      )}
    </div>
  );
}

const schema = z.object({
  type: z.enum(['OPERATION', 'API_ACCESS', 'IP_CERTIFICATE', 'SUPPORT']),
  service: z.string(),
  subject: z.string().trim().min(5, 'Décrivez la demande en 5 caractères au moins').max(200),
  reference: z
    .string()
    .trim()
    .max(60)
    .refine((v) => !FULL_PAN.test(v), 'Numéro de carte complet interdit : saisissez le format masqué (ex. 412345******2345)'),
});
type Form = z.infer<typeof schema>;

export function DemandeNouvelle() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { register, handleSubmit, formState, watch } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { type: (params.get('type') as Form['type']) ?? 'OPERATION', service: params.get('service') ?? 'CARTE', subject: params.get('subject') ?? '', reference: params.get('reference') ?? '' },
  });
  const isOperation = watch('type') === 'OPERATION';
  const create = useMutation({
    mutationFn: (f: Form) => {
      const context: Record<string, string> = {};
      if (f.type === 'OPERATION') context.service = f.service;
      if (f.reference) context.reference = f.reference;
      return post<ServiceRequest>('/portal/requests', { type: f.type, subject: f.subject, ...(Object.keys(context).length ? { context } : {}) });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['requests'] });
      navigate(`/demandes/${r.id}`);
    },
  });
  const e = formState.errors;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <PageHeader title="Nouvelle demande" subtitle="Le délai d’engagement est calculé en jours ouvrés dès l’envoi." />
      <form className="card stack" onSubmit={handleSubmit((f) => create.mutate(f))} noValidate>
        <Field label="Type de demande" error={e.type?.message}>
          {(p) => (
            <select {...p} {...register('type')}>
              {Object.entries(REQUEST_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          )}
        </Field>
        {isOperation && (
          <Field label="Service concerné" hint="Les demandes GAB, TPE et affiliation sont transmises automatiquement au Cockpit SMT.">
            {(p) => (
              <select {...p} {...register('service')}>
                {Object.entries(OPERATION_SERVICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            )}
          </Field>
        )}
        <Field label="Objet" error={e.subject?.message}>{(p) => <input {...p} {...register('subject')} />}</Field>
        <Field label="Référence (facultatif)" hint="Carte masquée, numéro de GAB, de commerçant ou de service" error={e.reference?.message}>
          {(p) => <input {...p} {...register('reference')} />}
        </Field>
        <ErrorBanner error={create.error} />
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={create.isPending}>Envoyer la demande</button>
          <Link className="btn btn-secondary" to="/demandes">Annuler</Link>
        </div>
      </form>
    </div>
  );
}

export function DemandeDetail() {
  const { id } = useParams();
  const can = useCan('demandes');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['requests', 'one', id], queryFn: () => api<ServiceRequest>(`/portal/requests/${id}`) });
  const act = useMutation({
    mutationFn: (action: 'reply' | 'reopen') => post<ServiceRequest>(`/portal/requests/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const r = q.data;
  return (
    <div className="stack" style={{ maxWidth: 880 }}>
      <PageHeader title={r.subject} subtitle={REQUEST_TYPE[r.type]} actions={<><Pill label={REQUEST_STATUS[r.status]} /><Pill label={SLA[r.sla]} /></>} />
      <Card title="Suivi">
        <dl className="details">
          <dt>Ouverte le</dt><dd>{formatDate(r.openedOn)}</dd>
          <dt>Échéance</dt><dd>{formatDate(r.dueDate)}</dd>
          <dt>Traitée le</dt><dd>{formatDate(r.doneOn)}</dd>
          {r.context && Object.entries(r.context).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k === 'reference' ? 'Référence' : k === 'service' ? 'Service' : k}</dt><dd className="mono">{k === 'service' ? (OPERATION_SERVICE[v] ?? v) : v}</dd></div>)}
          {r.externalMessage && <><dt>Message de SMT</dt><dd>{r.externalMessage}</dd></>}
          {r.rejectionReason && <><dt>Motif du rejet</dt><dd>{r.rejectionReason}</dd></>}
        </dl>
      </Card>
      <ErrorBanner error={act.error} />
      {can && (
        <div className="row">
          {r.status === 'WAITING_BANK' && <button className="btn btn-primary" onClick={() => act.mutate('reply')} disabled={act.isPending}>J’ai fourni les éléments demandés</button>}
          {(r.status === 'DONE' || r.status === 'CLOSED') && <button className="btn btn-secondary" onClick={() => act.mutate('reopen')} disabled={act.isPending}>Rouvrir la demande</button>}
        </div>
      )}
    </div>
  );
}
