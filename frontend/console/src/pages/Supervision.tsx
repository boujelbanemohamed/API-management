import { useQuery } from '@tanstack/react-query';
import { api, Card, ErrorBanner, Kpi, Loading, PageHeader, Pill, Table } from '@smt/ui';

interface Sup { checks: { name: string; status: string; detail?: string; ms?: number }[]; outbox: { PENDING: number; PUBLISHED: number; FAILED: number; stuck: { id: string; topic: string; status: string; attempts: number; lastError: string | null; createdAt: string }[] }; settings: Record<string, string | boolean | null> }

/** Paramètres et supervision : état des dépendances, messages en attente, réglages en vigueur. */
export function Supervision() {
  const q = useQuery({ queryKey: ['supervision'], queryFn: () => api<Sup>('/console/supervision'), refetchInterval: 30_000 });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const s = q.data;
  return (
    <div className="stack">
      <PageHeader title="Paramètres et supervision" subtitle="Actualisé toutes les 30 secondes" />
      <Table caption="État des services" rows={s.checks} rowKey={(c) => c.name} empty="—"
        columns={[
          { header: 'Service', cell: (c) => c.name },
          { header: 'État', cell: (c) => <Pill label={c.status === 'ok' ? { text: 'Disponible', tone: 'ok' } : c.status === 'ko' ? { text: 'Indisponible', tone: 'danger' } : { text: 'Non configuré' }} /> },
          { header: 'Temps de réponse', cell: (c) => (c.ms !== undefined ? `${c.ms} ms` : '—') },
          { header: 'Détail', cell: (c) => <span className="kpi-label">{c.detail ?? ''}</span> },
        ]} />
      <div className="grid grid-3">
        <Kpi label="Messages en attente d’envoi" value={s.outbox.PENDING} />
        <Kpi label="Messages en échec définitif" value={s.outbox.FAILED} hint="À traiter par l’exploitation" />
        <Kpi label="Messages publiés" value={s.outbox.PUBLISHED} />
      </div>
      {s.outbox.stuck.length > 0 && (
        <Table caption="Messages non publiés" rows={s.outbox.stuck} rowKey={(m) => m.id} empty="—"
          columns={[
            { header: 'Sujet', cell: (m) => <span className="mono">{m.topic}</span> },
            { header: 'État', cell: (m) => m.status },
            { header: 'Essais', cell: (m) => m.attempts },
            { header: 'Dernière erreur', cell: (m) => <span className="kpi-label">{m.lastError ?? '—'}</span> },
          ]} />
      )}
      <Card title="Réglages en vigueur">
        <dl className="details">
          <dt>Environnement de la passerelle</dt><dd>{String(s.settings.environment)}</dd>
          <dt>Production sans PV signé</dt><dd>{s.settings.onboardingEnforced ? 'Interdite' : 'Autorisée (reprise de l’existant)'}</dd>
          <dt>Messagerie</dt><dd>{String(s.settings.broker)}</dd>
          <dt>Assistant</dt><dd>{String(s.settings.assistant)}</dd>
        </dl>
        <p className="kpi-label">Les engagements de service et les jours fériés se règlent dans « Engagements ».</p>
      </Card>
    </div>
  );
}
