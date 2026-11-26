import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, Card, Empty, ErrorBanner, Field, Loading, PageHeader, Pill } from '@smt/ui';
import { useCan } from '../session';
import type { CatalogueItem, Onboarding, PlanItem } from '../types';

export function Catalogue() {
  const can = useCan('developpeurs');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const cat = useQuery({ queryKey: ['catalogue'], queryFn: () => api<CatalogueItem[]>('/portal/catalogue') });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api<PlanItem[]>('/portal/plans') });
  const request = useMutation({
    mutationFn: (v: { apiId: string; planId: string }) => post<Onboarding>('/portal/onboardings', v),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ['onboardings'] });
      navigate(`/mises-en-service/${o.id}`);
    },
  });
  if (cat.isPending) return <Loading />;
  return (
    <div className="stack">
      <PageHeader title="Catalogue des services" subtitle="Services proposés par SMT. Chaque demande ouvre une mise en service : contrat, sandbox, tests, recette." />
      <ErrorBanner error={cat.error ?? plans.error ?? request.error} />
      {(cat.data ?? []).length === 0 && <div className="card"><Empty>Aucun service publié pour l’instant.</Empty></div>}
      <div className="grid grid-3">
        {(cat.data ?? []).map((s) => (
          <Card key={s.id} title={s.name} actions={s.status === 'BETA' ? <Pill label={{ text: 'Bêta : sandbox seulement', tone: 'warn' }} /> : undefined}>
            <p style={{ margin: 0, color: 'var(--muted)' }}>{s.description ?? 'Description à venir.'}</p>
            <div className="mono">{s.publicPath} · v{s.version}</div>
            {can && (
              <>
                <Field label="Plan souhaité">
                  {(p) => (
                    <select {...p} value={choice[s.id] ?? ''} onChange={(e) => setChoice({ ...choice, [s.id]: e.target.value })}>
                      <option value="">Choisir un plan…</option>
                      {(plans.data ?? []).map((pl) => (
                        <option key={pl.id} value={pl.id}>{pl.name} — {pl.dailyQuota.toLocaleString('fr-FR')} appels/jour</option>
                      ))}
                    </select>
                  )}
                </Field>
                <button className="btn btn-primary" disabled={!choice[s.id] || request.isPending} onClick={() => request.mutate({ apiId: s.id, planId: choice[s.id] })}>
                  Demander la mise en service
                </button>
              </>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
