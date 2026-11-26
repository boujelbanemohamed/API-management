import { useState } from 'react';
import { ErrorBanner, Field, formatDate, Loading, PageHeader, Pill, Table, REQUEST_STATUS, REQUEST_TYPE, SLA } from '@smt/ui';
import { useCan, useMe } from '../session';
import { askReason, useAction, useList } from '../common';

interface Req { id: string; partnerId: string; type: string; subject: string; status: string; team: string; assignee: string | null; sensitive: boolean; preparedBy: string | null; openedOn: string; dueDate: string; sla: string; routedTo: string | null; externalMessage: string | null }

const TEAMS: Record<string, string> = { OPERATIONS: 'Opérations', INTEGRATION: 'Intégration', SECURITY: 'Sécurité', SUPPORT: 'Support' };

export function FileDemandes() {
  const me = useMe();
  const can = useCan('demandes');
  const [team, setTeam] = useState('');
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({ ...(team && { team }), ...(status && { status }) }).toString();
  const q = useList<Req>('requests', `/requests${qs ? `?${qs}` : ''}`);
  const partners = useList<{ id: string; code: string }>('partners', '/partners');
  const act = useAction(['requests']);
  const code = (id: string) => partners.data?.find((p) => p.id === id)?.code ?? '…';
  const run = (r: Req, action: string, body?: unknown) => act.mutate({ path: `/requests/${r.id}/${action}`, body });

  const actions = (r: Req) => {
    if (!can) return null;
    if (r.routedTo) return <span className="kpi-label">Traitée par le Cockpit</span>;
    const b = (label: string, onClick: () => void, primary = false) => (
      <button key={label} className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`} onClick={onClick} disabled={act.isPending}>{label}</button>
    );
    const list = [];
    if (r.status === 'NEW' || (r.status === 'IN_PROGRESS' && r.assignee !== me.username)) list.push(b('Prendre en charge', () => run(r, 'assign', { assignee: me.username }), r.status === 'NEW'));
    if (r.status === 'IN_PROGRESS') {
      list.push(b(r.sensitive ? 'Préparer (validation requise)' : 'Marquer traitée', () => run(r, 'complete'), true));
      list.push(b('Attendre la banque', () => run(r, 'wait', { on: 'BANK' })));
      list.push(b('Attendre un tiers', () => run(r, 'wait', { on: 'THIRD_PARTY' })));
    }
    if (r.status === 'WAITING_BANK' || r.status === 'WAITING_THIRD_PARTY') list.push(b('Reprendre', () => run(r, 'resume')));
    if (r.status === 'AWAITING_VALIDATION') {
      list.push(r.preparedBy === me.username ? <span key="self" className="kpi-label">Préparée par vous : validation par un autre agent</span> : b('Valider', () => run(r, 'validate'), true));
    }
    if (r.status === 'DONE') list.push(b('Clôturer', () => run(r, 'close')));
    if (['NEW', 'IN_PROGRESS', 'WAITING_BANK', 'WAITING_THIRD_PARTY', 'AWAITING_VALIDATION'].includes(r.status)) {
      list.push(b('Rejeter', () => { const reason = askReason('Motif du rejet (communiqué à la banque)'); if (reason) run(r, 'reject', { reason }); }));
    }
    return <div className="row">{list}</div>;
  };

  return (
    <div className="stack">
      <PageHeader title="File des demandes" subtitle="Délais en jours ouvrés tunisiens ; alerte à 75 %, dépassement à 100 %" />
      <div className="row">
        <Field label="Équipe">{(p) => <select {...p} value={team} onChange={(e) => setTeam(e.target.value)}><option value="">Toutes</option>{Object.entries(TEAMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        <Field label="État">{(p) => <select {...p} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Tous</option>{Object.entries(REQUEST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}</select>}</Field>
      </div>
      <ErrorBanner error={q.error ?? act.error} />
      {q.isPending ? <Loading /> : (
        <Table
          caption="File des demandes"
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          empty="Aucune demande."
          columns={[
            { header: 'Banque', cell: (r) => code(r.partnerId) },
            { header: 'Objet', cell: (r) => <>{r.subject}{r.sensitive && <> <Pill label={{ text: 'Sensible', tone: 'warn' }} /></>}{r.routedTo && <> <Pill label={{ text: 'Cockpit', tone: 'info' }} /></>}{r.externalMessage && <div className="kpi-label">{r.externalMessage}</div>}</> },
            { header: 'Type', cell: (r) => REQUEST_TYPE[r.type] },
            { header: 'Équipe', cell: (r) => TEAMS[r.team] ?? r.team },
            { header: 'Agent', cell: (r) => r.assignee ?? '—' },
            { header: 'Échéance', cell: (r) => formatDate(r.dueDate) },
            { header: 'État', cell: (r) => <Pill label={REQUEST_STATUS[r.status]} /> },
            { header: 'Délai', cell: (r) => <Pill label={SLA[r.sla]} /> },
            { header: 'Actions', cell: actions },
          ]}
        />
      )}
    </div>
  );
}
