import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, ErrorBanner, Field, Loading, PageHeader, Pill, Table } from '@smt/ui';
import { useMe } from '../session';

interface User { id: string; username: string; email: string; firstName: string; lastName: string; enabled: boolean; roles: string[] }
export const CONSOLE_ROLES: Record<string, string> = {
  'console-admin': 'Administrateur', 'console-agent-operations': 'Agent opérations', 'console-agent-integration': 'Agent intégration',
  'console-agent-securite': 'Agent sécurité', 'console-agent-support': 'Agent support', 'console-agent-litiges': 'Agent litiges',
  'console-arbitre': 'Arbitre', 'console-facturation': 'Facturation', 'console-auditeur': 'Auditeur',
};

export function Utilisateurs() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/console/users') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const [f, setF] = useState({ username: '', email: '', firstName: '', lastName: '', role: 'console-agent-support' });
  const [created, setCreated] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const create = useMutation({ mutationFn: () => post<{ username: string; temporaryPassword: string }>('/console/users', { username: f.username, email: f.email, firstName: f.firstName, lastName: f.lastName, roles: [f.role] }), onSuccess: (r) => { setCreated(r); refresh(); } });
  const setRole = useMutation({ mutationFn: (v: { id: string; role: string }) => api(`/console/users/${v.id}/roles`, { method: 'PUT', body: { roles: [v.role] } }), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (u: User) => post(`/console/users/${u.id}/${u.enabled ? 'disable' : 'enable'}`), onSuccess: refresh });
  return (
    <div className="stack">
      <PageHeader title="Utilisateurs SMT" subtitle="Comptes de la console ; le rôle détermine les sections du menu" />
      {created && <div className="banner banner-ok" role="status">Compte <strong>{created.username}</strong> créé. Mot de passe temporaire, affiché une seule fois : <span className="mono">{created.temporaryPassword}</span></div>}
      <form className="card row" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Identifiant">{(p) => <input {...p} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required />}</Field>
        <Field label="Adresse électronique">{(p) => <input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
        <Field label="Prénom">{(p) => <input {...p} value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} required />}</Field>
        <Field label="Nom">{(p) => <input {...p} value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} required />}</Field>
        <Field label="Rôle">{(p) => <select {...p} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(CONSOLE_ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        <button className="btn btn-primary" type="submit" disabled={create.isPending}>Créer</button>
      </form>
      <ErrorBanner error={q.error ?? create.error ?? setRole.error ?? toggle.error} />
      {q.isPending ? <Loading /> : (
        <Table caption="Utilisateurs SMT" rows={q.data ?? []} rowKey={(u) => u.id} empty="Aucun utilisateur."
          columns={[
            { header: 'Utilisateur', cell: (u) => <><strong>{u.username}</strong><div className="kpi-label">{u.firstName} {u.lastName} · {u.email}</div></> },
            { header: 'Rôle', cell: (u) => <Field label={`Rôle de ${u.username}`}>{(p) => <select {...p} value={u.roles[0] ?? ''} onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value })}>{Object.entries(CONSOLE_ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field> },
            { header: 'État', cell: (u) => <Pill label={u.enabled ? { text: 'Actif', tone: 'ok' } : { text: 'Désactivé', tone: 'danger' }} /> },
            { header: 'Actions', cell: (u) => u.username !== me.username && <button className="btn btn-secondary" onClick={() => toggle.mutate(u)}>{u.enabled ? 'Désactiver' : 'Réactiver'}</button> },
          ]} />
      )}
    </div>
  );
}
