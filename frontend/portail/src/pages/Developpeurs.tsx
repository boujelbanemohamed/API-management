import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, Card, ErrorBanner, formatDate, Loading, PageHeader, Pill, Table, SUBSCRIPTION_STATUS } from '@smt/ui';
import { useMe } from '../session';

interface Access { id: string; api: string; path: string; status: string; startDate: string; endDate: string | null }
interface Credentials { apiKeyCreatedAt: string | null; apiKeyFingerprint: string | null; gateways: { sandbox: string; production: string }; sandbox: Access[]; production: Access[] }

const useCredentials = () => useQuery({ queryKey: ['credentials'], queryFn: () => api<Credentials>('/portal/credentials') });

function AccessTable({ caption, rows }: { caption: string; rows: Access[] }) {
  return (
    <Table caption={caption} rows={rows} rowKey={(a) => a.id} empty="Aucun accès."
      columns={[
        { header: 'Service', cell: (a) => a.api },
        { header: 'Chemin', cell: (a) => <span className="mono">{a.path}</span> },
        { header: 'État', cell: (a) => <Pill label={SUBSCRIPTION_STATUS[a.status]} /> },
        { header: 'Validité', cell: (a) => `${formatDate(a.startDate)} → ${formatDate(a.endDate)}` },
      ]} />
  );
}

/** Identifiants : clé d'API (générée et affichée une seule fois), accès de production. */
export function Identifiants() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useCredentials();
  const [key, setKey] = useState<string | null>(null);
  const canRotate = me.roles.includes('banque-developpeur') || me.roles.includes('banque-admin-securite');
  const rotate = useMutation({ mutationFn: () => post<{ apiKey: string }>('/portal/credentials/api-key'), onSuccess: (r) => { setKey(r.apiKey); qc.invalidateQueries({ queryKey: ['credentials'] }); } });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const c = q.data;
  return (
    <div className="stack">
      <PageHeader title="Identifiants" subtitle="Clé d’API de votre banque pour appeler la passerelle SMT" />
      <Card title="Clé d’API">
        <dl className="details">
          <dt>Clé en service</dt><dd>{c.apiKeyCreatedAt ? <>créée le {formatDate(c.apiKeyCreatedAt)} · empreinte <span className="mono">{c.apiKeyFingerprint}</span></> : 'Aucune clé générée'}</dd>
          <dt>Passerelle de production</dt><dd className="mono">{c.gateways.production}</dd>
          <dt>En-tête à envoyer</dt><dd className="mono">apikey: &lt;votre clé&gt;</dd>
        </dl>
        {key && (
          <div className="banner banner-ok" role="status">
            Nouvelle clé, affichée une seule fois : <span className="mono" style={{ wordBreak: 'break-all' }}>{key}</span>. Conservez-la dans un coffre ; l’ancienne clé ne fonctionne plus.
          </div>
        )}
        {canRotate && (
          <div><button className="btn btn-primary" onClick={() => window.confirm('Générer une nouvelle clé ? L’ancienne cessera de fonctionner immédiatement.') && rotate.mutate()} disabled={rotate.isPending}>{c.apiKeyCreatedAt ? 'Renouveler la clé' : 'Générer la clé'}</button></div>
        )}
        <ErrorBanner error={rotate.error} />
      </Card>
      <h2>Accès de production</h2>
      <AccessTable caption="Accès de production" rows={c.production} />
    </div>
  );
}

/** Sandbox : simulateurs uniquement, jamais de vrai fournisseur. */
export function Sandbox() {
  const q = useCredentials();
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const c = q.data;
  const example = c.sandbox[0];
  return (
    <div className="stack">
      <PageHeader title="Sandbox" subtitle="Environnement de test : les appels arrivent sur des simulateurs, jamais sur un vrai fournisseur" />
      <Card title="Accès">
        <dl className="details">
          <dt>Passerelle sandbox</dt><dd className="mono">{c.gateways.sandbox}</dd>
          <dt>Identifiant</dt><dd>même clé d’API que la production (voir Identifiants)</dd>
        </dl>
        {example && (
          <>
            <p>Exemple d’appel :</p>
            <pre className="mono card" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{`curl -H "apikey: <votre clé>" ${c.gateways.sandbox}${example.path}/...`}</pre>
          </>
        )}
      </Card>
      <h2>Services ouverts en sandbox</h2>
      <AccessTable caption="Accès sandbox" rows={c.sandbox} />
    </div>
  );
}
