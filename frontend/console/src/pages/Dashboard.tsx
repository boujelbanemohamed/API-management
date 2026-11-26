import { Link } from 'react-router-dom';
import { Kpi, PageHeader } from '@smt/ui';
import { useMe } from '../session';
import { useList } from '../common';

const OPEN = ['NEW', 'IN_PROGRESS', 'WAITING_BANK', 'WAITING_THIRD_PARTY', 'AWAITING_VALIDATION'];

export function Dashboard() {
  const me = useMe();
  const has = (s: string) => me.sections.includes(s);
  const requests = useList<{ status: string; sla: string }>('requests', '/requests', has('demandes'));
  const disputes = useList<{ stage: string }>('disputes', '/disputes', has('litiges'));
  const onboardings = useList<{ step: string; cancelled: boolean }>('onboardings', '/onboardings', has('mises-en-service'));
  const open = (requests.data ?? []).filter((r) => OPEN.includes(r.status));
  return (
    <div className="stack">
      <PageHeader title={`Bonjour ${me.username}`} subtitle="Activité de la plateforme" />
      <div className="grid grid-3">
        {has('demandes') && <Link to="/demandes" style={{ textDecoration: 'none', color: 'inherit' }}><Kpi label="Demandes ouvertes" value={open.length} hint={`${open.filter((r) => r.sla === 'ALERT').length} en alerte · ${open.filter((r) => r.sla === 'BREACH').length} en dépassement`} /></Link>}
        {has('demandes') && <Kpi label="Validations en attente" value={open.filter((r) => r.status === 'AWAITING_VALIDATION').length} hint="Double validation requise" />}
        {has('litiges') && <Link to="/litiges" style={{ textDecoration: 'none', color: 'inherit' }}><Kpi label="Arbitrages à rendre" value={(disputes.data ?? []).filter((d) => d.stage === 'ARBITRATION_REQUESTED').length} /></Link>}
        {has('mises-en-service') && <Link to="/mises-en-service" style={{ textDecoration: 'none', color: 'inherit' }}><Kpi label="Recettes à signer" value={(onboardings.data ?? []).filter((o) => o.step === 'ACCEPTANCE' && !o.cancelled).length} /></Link>}
      </div>
    </div>
  );
}
