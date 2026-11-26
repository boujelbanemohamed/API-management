import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api, patch, post, Card, ErrorBanner, formatDate, Loading, PageHeader, Pill, Steps, Table,
  CASE_STATUS, ONBOARDING_STEP, STEP_ORDER, TEST_MODE,
} from '@smt/ui';
import { useCan, useMe } from '../session';
import type { CatalogueItem, Onboarding, TestCase } from '../types';

function useCatalogue() {
  return useQuery({ queryKey: ['catalogue'], queryFn: () => api<CatalogueItem[]>('/portal/catalogue'), staleTime: 60_000 });
}

export function MisesEnServiceListe() {
  const q = useQuery({ queryKey: ['onboardings'], queryFn: () => api<Onboarding[]>('/portal/onboardings') });
  const cat = useCatalogue();
  const name = (apiId: string) => cat.data?.find((c) => c.id === apiId)?.name ?? '…';
  return (
    <div className="stack">
      <PageHeader
        title="Mises en service"
        subtitle="Contrat, sandbox, tests, recette, production : aucun service n’est ouvert en production sans PV signé par votre banque et par SMT."
        actions={<Link className="btn btn-secondary" to="/catalogue">Demander un nouveau service</Link>}
      />
      <ErrorBanner error={q.error} />
      {q.isPending ? <Loading /> : (
        <Table
          caption="Mises en service"
          rows={q.data ?? []}
          rowKey={(o) => o.id}
          empty="Aucune mise en service. Choisissez un service dans le catalogue."
          columns={[
            { header: 'Service', cell: (o) => <Link to={`/mises-en-service/${o.id}`}>{name(o.apiId)}</Link> },
            { header: 'Étape', cell: (o) => (o.cancelled ? <Pill label={{ text: 'Annulée' }} /> : <Pill label={{ text: ONBOARDING_STEP[o.step], tone: o.step === 'PRODUCTION' ? 'ok' : 'accent' }} />) },
            { header: 'Mode de test', cell: (o) => (o.testMode ? TEST_MODE[o.testMode] : '—') },
            { header: 'Ouverte le', cell: (o) => formatDate(o.createdAt) },
          ]}
        />
      )}
    </div>
  );
}

export function MiseEnServiceDetail() {
  const { id } = useParams();
  const me = useMe();
  const canTest = useCan('developpeurs');
  const isSecurityAdmin = me.roles.includes('banque-admin-securite');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['onboardings', 'one', id], queryFn: () => api<Onboarding>(`/portal/onboardings/${id}`) });
  const cat = useCatalogue();
  const refresh = () => qc.invalidateQueries({ queryKey: ['onboardings'] });
  const setCase = useMutation({
    mutationFn: (v: { caseId: string; status: string; evidence?: string }) =>
      patch<TestCase>(`/portal/onboardings/${id}/cases/${v.caseId}`, { status: v.status, ...(v.evidence ? { evidence: v.evidence } : {}) }),
    onSuccess: refresh,
  });
  const sign = useMutation({ mutationFn: () => post<Onboarding>(`/portal/onboardings/${id}/sign`), onSuccess: refresh });

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const o = q.data;
  const service = cat.data?.find((c) => c.id === o.apiId);
  const cases = o.testCases ?? [];
  return (
    <div className="stack" style={{ maxWidth: 1040 }}>
      <PageHeader title={`Mise en service — ${service?.name ?? ''}`} subtitle={o.cancelled ? 'Annulée' : `Étape : ${ONBOARDING_STEP[o.step]}`} />
      <Steps steps={STEP_ORDER} current={o.step} labels={ONBOARDING_STEP} />
      <Card title="Dossier">
        <dl className="details">
          <dt>Contrat</dt><dd>{o.contractReference ?? 'En attente'}</dd>
          <dt>Mode de test</dt><dd>{o.testMode ? TEST_MODE[o.testMode] : 'À définir avec SMT'}</dd>
          <dt>Sessions conjointes</dt><dd>{o.jointSessions}</dd>
          <dt>PV signé par la banque</dt><dd>{o.bankSignedBy ?? 'Non'}</dd>
          <dt>PV signé par SMT</dt><dd>{o.smtSignedBy ?? 'Non'}</dd>
        </dl>
      </Card>
      <Card title="Cahier de tests">
        <Table
          caption="Cas de test"
          rows={cases}
          rowKey={(c) => c.id}
          empty="Le cahier de tests sera fourni par SMT à l’étape sandbox."
          columns={[
            { header: 'Cas', cell: (c) => <><span className="mono">{c.code}</span> {c.title}{c.mandatory && <> <Pill label={{ text: 'Obligatoire' }} /></>}</> },
            { header: 'Résultat', cell: (c) => <Pill label={CASE_STATUS[c.status]} /> },
            { header: 'Preuve', cell: (c) => <span className="mono">{c.evidence ?? '—'}</span> },
            {
              header: 'Action',
              cell: (c) =>
                canTest && o.step === 'TESTS' ? (
                  <div className="row">
                    <button className="btn btn-secondary" onClick={() => { const ev = window.prompt('Référence de la preuve (identifiant de trace, capture)', c.evidence ?? ''); if (ev) setCase.mutate({ caseId: c.id, status: 'PASSED', evidence: ev }); }}>Réussi</button>
                    <button className="btn btn-secondary" onClick={() => setCase.mutate({ caseId: c.id, status: 'FAILED' })}>Échoué</button>
                  </div>
                ) : null,
            },
          ]}
        />
        <ErrorBanner error={setCase.error} />
      </Card>
      {o.step === 'ACCEPTANCE' && (
        <Card title="PV de recette">
          <p>La mise en production exige la signature de votre administrateur sécurité <strong>et</strong> celle de SMT.</p>
          {o.bankSignedBy ? (
            <div className="banner banner-ok">Signé par {o.bankSignedBy} pour votre banque.</div>
          ) : isSecurityAdmin ? (
            <div><button className="btn btn-primary" onClick={() => sign.mutate()} disabled={sign.isPending}>Signer le PV au nom de la banque</button></div>
          ) : (
            <div className="banner banner-info">Seul l’administrateur sécurité de votre banque peut signer le PV.</div>
          )}
          <ErrorBanner error={sign.error} />
        </Card>
      )}
    </div>
  );
}
