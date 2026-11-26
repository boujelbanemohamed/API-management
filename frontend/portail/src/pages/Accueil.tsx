import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, Card, formatDate, Kpi, PageHeader, Pill, DISPUTE_STAGE, REQUEST_STATUS } from '@smt/ui';
import { useMe } from '../session';
import type { Dispute, Onboarding, ServiceRequest } from '../types';
import { myTurn } from './Litiges';

const OPEN = ['NEW', 'IN_PROGRESS', 'WAITING_BANK', 'WAITING_THIRD_PARTY', 'AWAITING_VALIDATION'];

export function Accueil() {
  const me = useMe();
  const has = (s: string) => me.sections.includes(s);
  const requests = useQuery({ queryKey: ['requests'], queryFn: () => api<ServiceRequest[]>('/portal/requests'), enabled: has('demandes') });
  const disputes = useQuery({ queryKey: ['disputes'], queryFn: () => api<Dispute[]>('/portal/disputes'), enabled: has('litiges') });
  const onboardings = useQuery({ queryKey: ['onboardings'], queryFn: () => api<Onboarding[]>('/portal/onboardings'), enabled: has('developpeurs') });

  const openRequests = (requests.data ?? []).filter((r) => OPEN.includes(r.status));
  const waiting = openRequests.filter((r) => r.status === 'WAITING_BANK');
  const toAct = (disputes.data ?? []).filter((d) => myTurn(d, me.partner.id));
  const inProgress = (onboardings.data ?? []).filter((o) => !o.cancelled && o.step !== 'PRODUCTION');

  return (
    <div className="stack">
      <PageHeader title={`Bonjour ${me.username}`} subtitle={`${me.partner.name} — votre activité avec SMT`} />
      <div className="grid grid-3">
        {has('demandes') && <Kpi label="Demandes en cours" value={openRequests.length} hint={`${waiting.length} attendent votre réponse`} />}
        {has('litiges') && <Kpi label="Litiges à traiter" value={toAct.length} hint="C’est à vous d’agir" />}
        {has('developpeurs') && <Kpi label="Mises en service en cours" value={inProgress.length} />}
      </div>
      {has('demandes') && waiting.length > 0 && (
        <Card title="Demandes qui attendent votre réponse">
          <ul>
            {waiting.map((r) => (
              <li key={r.id}>
                <Link to={`/demandes/${r.id}`}>{r.subject}</Link> <Pill label={REQUEST_STATUS[r.status]} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {has('litiges') && toAct.length > 0 && (
        <Card title="Litiges : échéances">
          <ul>
            {toAct.map((d) => (
              <li key={d.id}>
                <Link to={`/litiges/${d.id}`}>Transaction {d.transactionRef}</Link> <Pill label={DISPUTE_STAGE[d.stage]} /> — échéance {formatDate(d.deadline)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
