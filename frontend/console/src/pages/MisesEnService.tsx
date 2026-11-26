import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, Card, ErrorBanner, Field, formatDate, Loading, PageHeader, Pill, Steps, Table, CASE_STATUS, ONBOARDING_STEP, STEP_ORDER, TEST_MODE } from '@smt/ui';
import { useCan, useMe } from '../session';
import { ApiRow, PartnerRow, useAction, useList } from '../common';

interface Onb { id: string; partnerId: string; apiId: string; step: string; cancelled: boolean; testMode: string | null; jointSessions: number; contractReference: string | null; contractValidatedBy: string | null; bankSignedBy: string | null; smtSignedBy: string | null; createdAt: string; testCases?: { id: string; code: string; title: string; mandatory: boolean; status: string; evidence: string | null }[] }

function useNames() {
  const partners = useList<PartnerRow>('partners', '/partners');
  const apis = useList<ApiRow>('apis', '/apis');
  return { bank: (id: string) => partners.data?.find((p) => p.id === id)?.code ?? '…', api: (id: string) => apis.data?.find((a) => a.id === id)?.name ?? '…' };
}

export function MisesEnServiceConsole() {
  const q = useList<Onb>('onboardings', '/onboardings');
  const n = useNames();
  return (
    <div className="stack">
      <PageHeader title="Mises en service" subtitle="Demande → Contrat → Sandbox → Tests → Recette → Production" />
      <ErrorBanner error={q.error} />
      {q.isPending ? <Loading /> : (
        <Table caption="Mises en service" rows={q.data ?? []} rowKey={(o) => o.id} empty="Aucune mise en service."
          columns={[
            { header: 'Banque', cell: (o) => n.bank(o.partnerId) },
            { header: 'Service', cell: (o) => <Link to={`/mises-en-service/${o.id}`}>{n.api(o.apiId)}</Link> },
            { header: 'Étape', cell: (o) => (o.cancelled ? 'Annulée' : <Pill label={{ text: ONBOARDING_STEP[o.step], tone: o.step === 'PRODUCTION' ? 'ok' : 'accent' }} />) },
            { header: 'Ouverte le', cell: (o) => formatDate(o.createdAt) },
          ]} />
      )}
    </div>
  );
}

export function MiseEnServiceConsoleDetail() {
  const { id } = useParams();
  const can = useCan('mises-en-service');
  const me = useMe();
  const n = useNames();
  const q = useQuery({ queryKey: ['onboardings', 'one', id], queryFn: () => api<Onb>(`/onboardings/${id}`) });
  const act = useAction(['onboardings']);
  const [contract, setContract] = useState({ ref: '', by: '' });
  const [newCase, setNewCase] = useState({ code: '', title: '' });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const o = q.data;
  const go = (path: string, body?: unknown) => act.mutate({ path: `/onboardings/${id}${path}`, body });
  const open = !o.cancelled && o.step !== 'PRODUCTION';
  return (
    <div className="stack" style={{ maxWidth: 1040 }}>
      <PageHeader title={`${n.api(o.apiId)} — ${n.bank(o.partnerId)}`} subtitle={o.cancelled ? 'Annulée' : `Étape : ${ONBOARDING_STEP[o.step]}`}
        actions={can && open && <><button className="btn btn-primary" onClick={() => go('/advance')} disabled={act.isPending}>Passer à l’étape suivante</button><button className="btn btn-secondary" onClick={() => window.confirm('Annuler cette mise en service ?') && go('/cancel')}>Annuler</button></>} />
      <Steps steps={STEP_ORDER} current={o.step} labels={ONBOARDING_STEP} />
      <ErrorBanner error={act.error} />
      <Card title="Dossier">
        <dl className="details">
          <dt>Contrat</dt><dd>{o.contractReference ? `${o.contractReference} (validé par ${o.contractValidatedBy})` : 'Non joint'}</dd>
          <dt>Mode de test</dt><dd>{o.testMode ? TEST_MODE[o.testMode] : '—'}</dd>
          <dt>Sessions conjointes</dt><dd>{o.jointSessions}</dd>
          <dt>PV banque</dt><dd>{o.bankSignedBy ?? 'Non signé'}</dd>
          <dt>PV SMT</dt><dd>{o.smtSignedBy ?? 'Non signé'}</dd>
        </dl>
        {can && o.step === 'CONTRACT' && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); go('/contract', { contractReference: contract.ref, validatedBy: contract.by }); }}>
            <Field label="Référence du contrat">{(p) => <input {...p} value={contract.ref} onChange={(e) => setContract({ ...contract, ref: e.target.value })} required />}</Field>
            <Field label="Validé par (juriste)">{(p) => <input {...p} value={contract.by} onChange={(e) => setContract({ ...contract, by: e.target.value })} required />}</Field>
            <button className="btn btn-secondary" type="submit">Enregistrer le contrat</button>
          </form>
        )}
        {can && (o.step === 'SANDBOX' || o.step === 'TESTS') && (
          <div className="row">
            <Field label="Mode de test">{(p) => <select {...p} value={o.testMode ?? ''} onChange={(e) => go('/test-mode', { testMode: e.target.value })}><option value="" disabled>Choisir…</option>{Object.entries(TEST_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
            {o.step === 'TESTS' && o.testMode !== 'AUTONOMOUS' && <button className="btn btn-secondary" onClick={() => go('/joint-sessions')}>Enregistrer une session conjointe</button>}
          </div>
        )}
      </Card>
      <Card title="Cahier de tests">
        <Table caption="Cas de test" rows={o.testCases ?? []} rowKey={(c) => c.id} empty="Aucun cas."
          columns={[
            { header: 'Cas', cell: (c) => <><span className="mono">{c.code}</span> {c.title}</> },
            { header: 'Obligatoire', cell: (c) => (c.mandatory ? 'Oui' : 'Non') },
            { header: 'Résultat', cell: (c) => <Pill label={CASE_STATUS[c.status]} /> },
            { header: 'Preuve', cell: (c) => <span className="mono">{c.evidence ?? '—'}</span> },
          ]} />
        {can && (o.step === 'SANDBOX' || o.step === 'TESTS') && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); go('/cases', newCase); setNewCase({ code: '', title: '' }); }}>
            <Field label="Code du cas">{(p) => <input {...p} value={newCase.code} onChange={(e) => setNewCase({ ...newCase, code: e.target.value })} required />}</Field>
            <Field label="Intitulé">{(p) => <input {...p} value={newCase.title} onChange={(e) => setNewCase({ ...newCase, title: e.target.value })} required />}</Field>
            <button className="btn btn-secondary" type="submit">Ajouter le cas</button>
          </form>
        )}
      </Card>
      {o.step === 'ACCEPTANCE' && can && !o.smtSignedBy && (
        <Card title="PV de recette">
          <p>Signature au nom de SMT par <strong>{me.username}</strong>. La production reste bloquée tant que la banque n’a pas signé.</p>
          <div><button className="btn btn-primary" onClick={() => go('/sign', { party: 'SMT' })}>Signer le PV pour SMT</button></div>
        </Card>
      )}
    </div>
  );
}
