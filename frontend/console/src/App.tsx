import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, NavGroup, NavItem, NotificationsBell } from '@smt/ui';
import { useMe } from './session';
import { Dashboard } from './pages/Dashboard';
import { FileDemandes } from './pages/Demandes';
import { LitigesConsole, LitigeConsoleDetail } from './pages/Litiges';
import { MisesEnServiceConsole, MiseEnServiceConsoleDetail } from './pages/MisesEnService';
import { Partenaires, Abonnements } from './pages/Banques';
import { ApiProduits, Plans, Fournisseurs } from './pages/Catalogue';
import { Facturation } from './pages/Finance';
import { Engagements, JournalAudit } from './pages/Administration';
import { Contenus } from './pages/Contenus';
import { Utilisateurs } from './pages/Utilisateurs';

const LOT5 = 'Disponible au lot 5';

/** Menu de la console (structure validée), filtré selon les sections autorisées. */
function menu(sections: string[]): NavGroup[] {
  const has = (s: string) => sections.includes(s);
  const g = (label: string, items: (NavItem | false)[]): NavGroup | false => {
    const list = items.filter(Boolean) as NavItem[];
    return list.length > 0 && { label, items: list };
  };
  return [
    { items: [{ label: 'Tableau de bord', to: '/' }] },
    g('Activité', [
      has('demandes') && { label: 'File des demandes', to: '/demandes' },
      has('litiges') && { label: 'Litiges', to: '/litiges' },
      has('mises-en-service') && { label: 'Mises en service', to: '/mises-en-service' },
    ]),
    g('Banques', [has('banques') && { label: 'Partenaires', to: '/partenaires' }, has('banques') && { label: 'Abonnements', to: '/abonnements' }]),
    g('Catalogue', [
      has('catalogue') && { label: 'API et produits', to: '/apis' },
      has('catalogue') && { label: 'Plans', to: '/plans' },
      has('catalogue') && { label: 'Fournisseurs', to: '/fournisseurs' },
      has('catalogue') && { label: 'Cahiers de tests', soon: LOT5 },
    ]),
    g('Contenus', [has('administration') && { label: 'Communiqués, événements, enquêtes, bibliothèque', to: '/contenus' }]),
    g('Finance', [has('finance') && { label: 'Facturation', to: '/facturation' }, has('finance') && { label: 'Rapprochement', soon: LOT5 }]),
    g('Administration', [
      has('administration') && { label: 'Utilisateurs', to: '/utilisateurs' },
      has('administration') && { label: 'Engagements', to: '/engagements' },
      has('administration') && { label: 'Journal d’audit', to: '/audit' },
    ]),
  ].filter(Boolean) as NavGroup[];
}

export function App() {
  const me = useMe();
  const has = (s: string) => me.sections.includes(s);
  return (
    <Routes>
      <Route element={<AppShell brand="Console SMT" menuLabel="Menu de la console" groups={menu(me.sections)} context={<NotificationsBell base="/console/notifications" />} />}>
        <Route index element={<Dashboard />} />
        {has('demandes') && <Route path="demandes" element={<FileDemandes />} />}
        {has('litiges') && <><Route path="litiges" element={<LitigesConsole />} /><Route path="litiges/:id" element={<LitigeConsoleDetail />} /></>}
        {has('mises-en-service') && <><Route path="mises-en-service" element={<MisesEnServiceConsole />} /><Route path="mises-en-service/:id" element={<MiseEnServiceConsoleDetail />} /></>}
        {has('banques') && <><Route path="partenaires" element={<Partenaires />} /><Route path="abonnements" element={<Abonnements />} /></>}
        {has('catalogue') && <><Route path="apis" element={<ApiProduits />} /><Route path="plans" element={<Plans />} /><Route path="fournisseurs" element={<Fournisseurs />} /></>}
        {has('finance') && <Route path="facturation" element={<Facturation />} />}
        {has('administration') && <><Route path="engagements" element={<Engagements />} /><Route path="audit" element={<JournalAudit />} /><Route path="contenus" element={<Contenus />} /><Route path="utilisateurs" element={<Utilisateurs />} /></>}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
