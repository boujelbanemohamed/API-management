import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, Card, ErrorBanner, Field, formatAmount, formatDate, Loading, PageHeader, Pill, Table } from '@smt/ui';
import { useCan, useMe } from '../session';

/** Réponse du BFF : la source est toujours affichée (spécifications §12). */
interface Sourced<T> { source: string; items: T[] }

function useOps<T>(path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return useQuery({ queryKey: ['ops', path, qs], queryFn: () => api<Sourced<T>>(`/portal/operations/${path}${qs ? `?${qs}` : ''}`), retry: false });
}

function Source({ name }: { name?: string }) {
  return name ? <span className="pill pill-info" title="Données lues en direct chez le fournisseur">Source : {name}</span> : null;
}

/** Fournisseur indisponible : message clair et proposition de demande (F-OPS-04). */
function OpsError({ error, service }: { error: unknown; service: string }) {
  const can = useCan('demandes');
  if (!error) return null;
  const unavailable = error instanceof ApiError && error.status === 503;
  return (
    <div className="stack">
      <ErrorBanner error={error} />
      {unavailable && can && <div><Link className="btn btn-secondary" to={`/demandes/nouvelle?type=OPERATION&service=${service}`}>Créer une demande à SMT</Link></div>}
    </div>
  );
}

const demand = (service: string, subject: string, reference: string) =>
  `/demandes/nouvelle?${new URLSearchParams({ type: 'OPERATION', service, subject, reference }).toString()}`;

function Screen({ title, subtitle, source, children }: { title: string; subtitle: string; source?: string; children: ReactNode }) {
  return (
    <div className="stack">
      <PageHeader title={title} subtitle={subtitle} actions={<Source name={source} />} />
      {children}
    </div>
  );
}

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | undefined> = {
  ACTIVE: 'ok', ACTIF: 'ok', EN_SERVICE: 'ok', VALIDEE: 'ok', EN_PRODUCTION: 'ok', '00': 'ok',
  BLOCKED: 'danger', BLOQUE: 'danger', HORS_SERVICE: 'danger', SUSPENDU: 'danger',
  BILLETS_BAS: 'warn', DEGRADE: 'warn', PIECES_MANQUANTES: 'warn', EN_ETUDE: 'info', EXPIRED: undefined, EXPIRE: undefined,
};
const TEXT: Record<string, string> = {
  ACTIVE: 'Active', BLOCKED: 'En opposition', EXPIRED: 'Expirée', ACTIF: 'Actif', BLOQUE: 'Bloqué', EXPIRE: 'Expiré', SUSPENDU: 'Suspendu',
  EN_SERVICE: 'En service', HORS_SERVICE: 'Hors service', BILLETS_BAS: 'Billets bas', DEGRADE: 'Dégradé',
  EN_ETUDE: 'En étude', PIECES_MANQUANTES: 'Pièces manquantes', VALIDEE: 'Validée', EN_PRODUCTION: 'En production',
};
const Status = ({ v }: { v: string }) => <Pill label={{ text: TEXT[v] ?? v, tone: TONE[v] }} />;

// ---------- Transactions (Plateforme 1) ----------

interface Tx { reference: string; maskedPan: string; date: string; amount: number; merchant: string; city: string; channel: string; responseCode: string; acquirer: string }

export function Transactions() {
  const me = useMe();
  const canDispute = me.sections.includes('litiges');
  const [f, setF] = useState({ from: '', to: '', pan: '', reference: '', channel: '' });
  const [applied, setApplied] = useState(f);
  const q = useOps<Tx>('transactions', applied);
  return (
    <Screen title="Transactions" subtitle="Transactions de vos porteurs ; une transaction peut être contestée directement" source={q.data?.source}>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <Field label="Du">{(p) => <input {...p} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
        <Field label="Au">{(p) => <input {...p} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
        <Field label="Carte (début ou fin)" hint="Format masqué">{(p) => <input {...p} value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value })} />}</Field>
        <Field label="Référence">{(p) => <input {...p} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
        <Field label="Canal">{(p) => <select {...p} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="">Tous</option><option value="TPE">TPE</option><option value="GAB">GAB</option><option value="E-COMMERCE">E-commerce</option></select>}</Field>
        <button className="btn btn-primary" type="submit">Rechercher</button>
      </form>
      <OpsError error={q.error} service="CARTE" />
      {q.isPending ? <Loading /> : !q.error && (
        <Table caption="Transactions" rows={q.data?.items ?? []} rowKey={(t) => t.reference} empty="Aucune transaction pour ces critères."
          columns={[
            { header: 'Date', cell: (t) => new Date(t.date).toLocaleString('fr-FR') },
            { header: 'Référence', cell: (t) => <span className="mono">{t.reference}</span> },
            { header: 'Carte', cell: (t) => <span className="mono">{t.maskedPan}</span> },
            { header: 'Commerçant', cell: (t) => `${t.merchant}, ${t.city}` },
            { header: 'Canal', cell: (t) => t.channel },
            { header: 'Montant', cell: (t) => formatAmount(t.amount) },
            { header: 'Réponse', cell: (t) => <Pill label={{ text: t.responseCode === '00' ? 'Acceptée' : `Refusée (${t.responseCode})`, tone: t.responseCode === '00' ? 'ok' : 'danger' }} /> },
            {
              header: 'Action',
              cell: (t) => canDispute && t.responseCode === '00' && (
                <Link to={`/litiges/nouveau?${new URLSearchParams({ reference: t.reference, pan: t.maskedPan, date: t.date.slice(0, 10), amount: (t.amount / 1000).toFixed(3).replace('.', ','), acquirer: t.acquirer })}`}>Contester</Link>
              ),
            },
          ]} />
      )}
    </Screen>
  );
}

// ---------- Services cartes (SVIP) ----------

interface CardRow { id: string; maskedPan: string; holder: string; product: string; status: string; expiry: string; dailyLimit: number; pinTriesLeft: number }

export function ServicesCartes() {
  const can = useCan('demandes');
  const [f, setF] = useState({ pan: '', holder: '', status: '' });
  const [applied, setApplied] = useState(f);
  const q = useOps<CardRow>('cards', applied);
  return (
    <Screen title="Services cartes" subtitle="Consultation en direct ; les opérations passent par une demande à SMT (double validation si nécessaire)" source={q.data?.source}>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <Field label="Carte (début ou fin)">{(p) => <input {...p} value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value })} />}</Field>
        <Field label="Porteur">{(p) => <input {...p} value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} />}</Field>
        <Field label="État">{(p) => <select {...p} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Tous</option><option value="ACTIVE">Active</option><option value="BLOCKED">En opposition</option><option value="EXPIRED">Expirée</option></select>}</Field>
        <button className="btn btn-primary" type="submit">Rechercher</button>
      </form>
      <OpsError error={q.error} service="CARTE" />
      {q.isPending ? <Loading /> : !q.error && (
        <Table caption="Cartes" rows={q.data?.items ?? []} rowKey={(c) => c.id} empty="Aucune carte pour ces critères."
          columns={[
            { header: 'Carte', cell: (c) => <span className="mono">{c.maskedPan}</span> },
            { header: 'Porteur', cell: (c) => c.holder },
            { header: 'Produit', cell: (c) => c.product },
            { header: 'Expiration', cell: (c) => c.expiry },
            { header: 'Plafond journalier', cell: (c) => formatAmount(c.dailyLimit) },
            { header: 'Essais PIN restants', cell: (c) => c.pinTriesLeft },
            { header: 'État', cell: (c) => <Status v={c.status} /> },
            {
              header: 'Demander',
              cell: (c) => can && (
                <div className="row">
                  {c.status === 'ACTIVE' && <Link to={demand('CARTE', `Opposition de la carte ${c.maskedPan}`, c.maskedPan)}>Opposition</Link>}
                  {c.status === 'BLOCKED' && <Link to={demand('CARTE', `Levée d’opposition de la carte ${c.maskedPan}`, c.maskedPan)}>Lever l’opposition</Link>}
                  <Link to={demand('CARTE', `Réédition de la carte ${c.maskedPan}`, c.maskedPan)}>Réédition</Link>
                  <Link to={demand('CARTE', `Réinitialisation du PIN de la carte ${c.maskedPan}`, c.maskedPan)}>PIN</Link>
                  <Link to={demand('CARTE', `Modification du plafond de la carte ${c.maskedPan}`, c.maskedPan)}>Plafond</Link>
                </div>
              ),
            },
          ]} />
      )}
    </Screen>
  );
}

// ---------- GAB (Cockpit) ----------

interface Atm { id: string; location: string; status: string; cashLevel: number; lastIncident: string | null }

export function Gab() {
  const can = useCan('demandes');
  const q = useOps<Atm>('atms');
  const items = q.data?.items ?? [];
  return (
    <Screen title="GAB" subtitle="État de votre parc ; un incident ouvre une demande transmise au Cockpit" source={q.data?.source}>
      <OpsError error={q.error} service="GAB" />
      {q.isPending ? <Loading /> : !q.error && (
        <>
          <div className="grid grid-3">
            {['EN_SERVICE', 'DEGRADE', 'HORS_SERVICE'].map((s) => (
              <Card key={s}><div className="kpi-label">{TEXT[s]}</div><div className="kpi-value">{items.filter((a) => a.status === s || (s === 'DEGRADE' && a.status === 'BILLETS_BAS')).length}</div></Card>
            ))}
          </div>
          <Table caption="GAB" rows={items} rowKey={(a) => a.id} empty="Aucun GAB."
            columns={[
              { header: 'GAB', cell: (a) => <span className="mono">{a.id}</span> },
              { header: 'Emplacement', cell: (a) => a.location },
              { header: 'État', cell: (a) => <Status v={a.status} /> },
              { header: 'Niveau de billets', cell: (a) => `${a.cashLevel} %` },
              { header: 'Dernier incident', cell: (a) => a.lastIncident ?? '—' },
              { header: 'Demander', cell: (a) => can && a.status !== 'EN_SERVICE' && <Link to={demand('GAB', `Intervention sur le GAB ${a.id}${a.lastIncident ? ` (${a.lastIncident})` : ''}`, a.id)}>Intervention</Link> },
            ]} />
        </>
      )}
    </Screen>
  );
}

// ---------- Commerçants et TPE (Cockpit) ----------

interface Merchant { id: string; name: string; mcc: string; status: string; terminals: { id: string; model: string; status: string; lastTransaction: string }[] }

export function Commercants() {
  const can = useCan('demandes');
  const [name, setName] = useState('');
  const [applied, setApplied] = useState('');
  const q = useOps<Merchant>('merchants', { name: applied });
  return (
    <Screen title="Commerçants et TPE" subtitle="Vos commerçants acceptants et leurs terminaux" source={q.data?.source}>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); setApplied(name); }}>
        <Field label="Nom du commerçant">{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <button className="btn btn-primary" type="submit">Rechercher</button>
      </form>
      <OpsError error={q.error} service="TPE" />
      {q.isPending ? <Loading /> : !q.error && (
        <Table caption="Commerçants" rows={q.data?.items ?? []} rowKey={(m) => m.id} empty="Aucun commerçant."
          columns={[
            { header: 'Commerçant', cell: (m) => <><strong>{m.name}</strong> <span className="mono">{m.id}</span></> },
            { header: 'MCC', cell: (m) => <span className="mono">{m.mcc}</span> },
            { header: 'État', cell: (m) => <Status v={m.status} /> },
            {
              header: 'Terminaux',
              cell: (m) => (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {m.terminals.map((t) => (
                    <li key={t.id}>
                      <span className="mono">{t.id}</span> {t.model} <Status v={t.status} /> — dernière transaction {formatDate(t.lastTransaction)}
                      {can && t.status !== 'EN_SERVICE' && <> · <Link to={demand('TPE', `Intervention sur le TPE ${t.id} (${m.name})`, t.id)}>Intervention</Link></>}
                    </li>
                  ))}
                </ul>
              ),
            },
          ]} />
      )}
    </Screen>
  );
}

// ---------- Affiliation e-commerce (Cockpit) ----------

interface Aff { id: string; merchant: string; website: string; status: string; submittedOn: string }

export function Affiliation() {
  const can = useCan('demandes');
  const q = useOps<Aff>('affiliations');
  return (
    <Screen title="Affiliation e-commerce" subtitle="Dossiers d’affiliation de vos commerçants en ligne" source={q.data?.source}>
      {can && <div><Link className="btn btn-primary" to={demand('AFFILIATION', 'Nouvelle affiliation e-commerce : ', '')}>Nouveau dossier d’affiliation</Link></div>}
      <OpsError error={q.error} service="AFFILIATION" />
      {q.isPending ? <Loading /> : !q.error && (
        <Table caption="Dossiers d’affiliation" rows={q.data?.items ?? []} rowKey={(a) => a.id} empty="Aucun dossier."
          columns={[
            { header: 'Dossier', cell: (a) => <span className="mono">{a.id}</span> },
            { header: 'Commerçant', cell: (a) => a.merchant },
            { header: 'Site', cell: (a) => <span className="mono">{a.website}</span> },
            { header: 'Déposé le', cell: (a) => formatDate(a.submittedOn) },
            { header: 'État', cell: (a) => <Status v={a.status} /> },
            { header: 'Demander', cell: (a) => can && a.status === 'PIECES_MANQUANTES' && <Link to={demand('AFFILIATION', `Pièces complémentaires pour le dossier ${a.id}`, a.id)}>Compléter</Link> },
          ]} />
      )}
    </Screen>
  );
}

// ---------- Accès SmartVista (SVIP) ----------

interface SvUser { login: string; profile: string; status: string; lastLogin: string }

export function AccesSmartVista() {
  const can = useCan('demandes');
  const q = useOps<SvUser>('smartvista-users');
  return (
    <Screen title="Accès SmartVista" subtitle="Comptes de vos collaborateurs sur SmartVista ; création, modification et révocation par demande" source={q.data?.source}>
      {can && <div><Link className="btn btn-primary" to={demand('SMARTVISTA', 'Création d’un accès SmartVista pour : ', '')}>Demander un nouvel accès</Link></div>}
      <OpsError error={q.error} service="SMARTVISTA" />
      {q.isPending ? <Loading /> : !q.error && (
        <Table caption="Comptes SmartVista" rows={q.data?.items ?? []} rowKey={(u) => u.login} empty="Aucun compte."
          columns={[
            { header: 'Identifiant', cell: (u) => <span className="mono">{u.login}</span> },
            { header: 'Profil', cell: (u) => u.profile },
            { header: 'État', cell: (u) => <Status v={u.status} /> },
            { header: 'Dernière connexion', cell: (u) => formatDate(u.lastLogin) },
            {
              header: 'Demander',
              cell: (u) => can && (
                <div className="row">
                  {u.status === 'BLOQUE' && <Link to={demand('SMARTVISTA', `Déblocage du compte SmartVista ${u.login}`, u.login)}>Débloquer</Link>}
                  {u.status !== 'EXPIRE' && <Link to={demand('SMARTVISTA', `Révocation du compte SmartVista ${u.login}`, u.login)}>Révoquer</Link>}
                </div>
              ),
            },
          ]} />
      )}
    </Screen>
  );
}
