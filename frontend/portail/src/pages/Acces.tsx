import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, ErrorBanner, Field, Loading, PageHeader, Pill, Table } from '@smt/ui';
import { useMe } from '../session';

interface User { id: string; username: string; email: string; firstName: string; lastName: string; enabled: boolean; roles: string[] }

export const BANK_ROLES: Record<string, string> = {
  'banque-admin-securite': 'Administrateur sécurité',
  'banque-operateur-monetique': 'Opérateur monétique',
  'banque-gestionnaire-litiges': 'Gestionnaire litiges',
  'banque-developpeur': 'Développeur',
  'banque-facturation': 'Facturation',
  'banque-lecture': 'Lecture seule',
};

/** Gestion des accès de la banque (administrateur sécurité). */
export function GestionAcces() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/portal/users') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const [form, setForm] = useState({ username: '', email: '', firstName: '', lastName: '', roles: [] as string[] });
  const [created, setCreated] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; roles: string[] } | null>(null);
  const create = useMutation({ mutationFn: () => post<{ username: string; temporaryPassword: string }>('/portal/users', form), onSuccess: (r) => { setCreated(r); setForm({ username: '', email: '', firstName: '', lastName: '', roles: [] }); refresh(); } });
  const roles = useMutation({ mutationFn: (v: { id: string; roles: string[] }) => api(`/portal/users/${v.id}/roles`, { method: 'PUT', body: { roles: v.roles } }), onSuccess: () => { setEditing(null); refresh(); } });
  const toggle = useMutation({ mutationFn: (u: User) => post(`/portal/users/${u.id}/${u.enabled ? 'disable' : 'enable'}`), onSuccess: refresh });
  const pick = (list: string[], r: string) => (list.includes(r) ? list.filter((x) => x !== r) : [...list, r]);
  const RoleBoxes = ({ value, onChange, idp }: { value: string[]; onChange: (v: string[]) => void; idp: string }) => (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="kpi-label">Rôles</legend>
      <div className="row">
        {Object.entries(BANK_ROLES).map(([k, v]) => (
          <label key={k} htmlFor={`${idp}-${k}`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input id={`${idp}-${k}`} type="checkbox" checked={value.includes(k)} onChange={() => onChange(pick(value, k))} /> {v}
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <div className="stack">
      <PageHeader title="Gestion des accès" subtitle={`Utilisateurs de ${me.partner.name} sur le portail. La première connexion impose un nouveau mot de passe et la double authentification.`} />
      {created && (
        <div className="banner banner-ok" role="status">
          Compte <strong>{created.username}</strong> créé. Mot de passe temporaire, affiché une seule fois : <span className="mono">{created.temporaryPassword}</span>. Transmettez-le par un canal sûr.
          {' '}<button className="btn btn-secondary" onClick={() => setCreated(null)}>Masquer</button>
        </div>
      )}
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <h2>Nouvel utilisateur</h2>
        <div className="grid grid-3">
          <Field label="Identifiant" hint="minuscules, chiffres, point ou tiret">{(p) => <input {...p} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />}</Field>
          <Field label="Adresse électronique">{(p) => <input {...p} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />}</Field>
          <Field label="Prénom">{(p) => <input {...p} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />}</Field>
          <Field label="Nom">{(p) => <input {...p} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />}</Field>
        </div>
        <RoleBoxes idp="new" value={form.roles} onChange={(r) => setForm({ ...form, roles: r })} />
        <ErrorBanner error={create.error} />
        <div><button className="btn btn-primary" type="submit" disabled={create.isPending || form.roles.length === 0}>Créer l’utilisateur</button></div>
      </form>
      <ErrorBanner error={q.error ?? roles.error ?? toggle.error} />
      {q.isPending ? <Loading /> : (
        <Table caption="Utilisateurs de la banque" rows={q.data ?? []} rowKey={(u) => u.id} empty="Aucun utilisateur."
          columns={[
            { header: 'Utilisateur', cell: (u) => <><strong>{u.username}</strong><div className="kpi-label">{u.firstName} {u.lastName} · {u.email}</div></> },
            { header: 'Rôles', cell: (u) => editing?.id === u.id ? (
              <div className="stack">
                <RoleBoxes idp={u.id} value={editing.roles} onChange={(r) => setEditing({ id: u.id, roles: r })} />
                <div className="row"><button className="btn btn-primary" onClick={() => roles.mutate(editing)} disabled={editing.roles.length === 0}>Enregistrer</button><button className="btn btn-secondary" onClick={() => setEditing(null)}>Annuler</button></div>
              </div>
            ) : u.roles.map((r) => BANK_ROLES[r] ?? r).join(', ') },
            { header: 'État', cell: (u) => <Pill label={u.enabled ? { text: 'Actif', tone: 'ok' } : { text: 'Désactivé', tone: 'danger' }} /> },
            { header: 'Actions', cell: (u) => (
              <div className="row">
                {editing?.id !== u.id && <button className="btn btn-secondary" onClick={() => setEditing({ id: u.id, roles: u.roles })}>Modifier les rôles</button>}
                {u.username !== me.username && <button className="btn btn-secondary" onClick={() => toggle.mutate(u)}>{u.enabled ? 'Désactiver' : 'Réactiver'}</button>}
              </div>
            ) },
          ]} />
      )}
    </div>
  );
}
