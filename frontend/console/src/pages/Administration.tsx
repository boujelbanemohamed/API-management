import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ErrorBanner, Field, formatDate, Loading, PageHeader, Table, REQUEST_TYPE } from '@smt/ui';
import { useCan } from '../session';
import { useAction, useList } from '../common';

interface Commitment { type: string; team: string; slaDays: number }

export function Engagements() {
  const can = useCan('administration');
  const commitments = useList<Commitment>('commitments', '/commitments');
  const holidays = useList<{ date: string; label: string }>('holidays', '/holidays');
  const addHoliday = useAction(['holidays']);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (c: Commitment) => api(`/commitments/${c.type}`, { method: 'PUT', body: { team: c.team, slaDays: c.slaDays } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commitments'] }),
  });
  const [h, setH] = useState({ date: '', label: '' });
  return (
    <div className="stack">
      <PageHeader title="Engagements de service" subtitle="Délais par type de demande, en jours ouvrés ; jours fériés à date variable" />
      <ErrorBanner error={commitments.error ?? save.error ?? addHoliday.error} />
      {commitments.isPending ? <Loading /> : (
        <Table caption="Engagements" rows={commitments.data ?? []} rowKey={(c) => c.type} empty="—"
          columns={[
            { header: 'Type', cell: (c) => REQUEST_TYPE[c.type] },
            { header: 'Équipe', cell: (c) => c.team },
            {
              header: 'Délai (jours ouvrés)',
              cell: (c) => can ? (
                <Field label={`Délai ${REQUEST_TYPE[c.type]}`}>{(p) => <input {...p} type="number" min={1} defaultValue={c.slaDays} onBlur={(e) => Number(e.target.value) !== c.slaDays && save.mutate({ ...c, slaDays: Number(e.target.value) })} />}</Field>
              ) : c.slaDays,
            },
          ]} />
      )}
      <h2>Jours fériés à date variable</h2>
      <p className="kpi-label">Les fériés fixes (1er janvier, 20 mars, 9 avril, 1er mai, 25 juillet, 13 août, 15 octobre, 17 décembre) sont intégrés.</p>
      {can && (
        <form className="card row" onSubmit={(e) => { e.preventDefault(); addHoliday.mutate({ path: '/holidays', body: h }); setH({ date: '', label: '' }); }}>
          <Field label="Date">{(p) => <input {...p} type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required />}</Field>
          <Field label="Fête">{(p) => <input {...p} value={h.label} onChange={(e) => setH({ ...h, label: e.target.value })} required />}</Field>
          <button className="btn btn-primary" type="submit">Ajouter</button>
        </form>
      )}
      <Table caption="Jours fériés" rows={holidays.data ?? []} rowKey={(x) => x.date} empty="Aucune fête variable saisie."
        columns={[{ header: 'Date', cell: (x) => formatDate(x.date) }, { header: 'Fête', cell: (x) => x.label }]} />
    </div>
  );
}

interface AuditRow { id: string; at: string; actor: string; action: string; objectType: string; objectId: string }

export function JournalAudit() {
  const [actor, setActor] = useState('');
  const q = useList<AuditRow>('audit', `/audit${actor ? `?actor=${encodeURIComponent(actor)}` : ''}`);
  return (
    <div className="stack">
      <PageHeader title="Journal d’audit" subtitle="Toutes les actions, avec leur auteur" />
      <Field label="Auteur">{(p) => <input {...p} value={actor} onChange={(e) => setActor(e.target.value)} placeholder="ex. amel ou BNA:op.dupont" />}</Field>
      <ErrorBanner error={q.error} />
      {q.isPending ? <Loading /> : (
        <Table caption="Journal d’audit" rows={q.data ?? []} rowKey={(a) => a.id} empty="Aucun événement."
          columns={[
            { header: 'Date', cell: (a) => new Date(a.at).toLocaleString('fr-FR') },
            { header: 'Auteur', cell: (a) => a.actor },
            { header: 'Action', cell: (a) => <span className="mono">{a.action}</span> },
            { header: 'Objet', cell: (a) => <span className="mono">{a.objectType} {a.objectId.slice(0, 8)}</span> },
          ]} />
      )}
    </div>
  );
}
