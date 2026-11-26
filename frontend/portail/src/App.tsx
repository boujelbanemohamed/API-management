import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, NavGroup } from '@smt/ui';
import { useMe } from './session';
import { Accueil } from './pages/Accueil';
import { DemandesListe, DemandeNouvelle, DemandeDetail } from './pages/Demandes';
import { LitigesListe, LitigeNouveau, LitigeDetail } from './pages/Litiges';
import { MisesEnServiceListe, MiseEnServiceDetail } from './pages/MisesEnService';
import { Catalogue } from './pages/Catalogue';
import { Consommation } from './pages/Consommation';

const LOT4 = 'Disponible avec la couche d’intégration (lot 4)';
const LOT5 = 'Disponible au lot 5';

/** Menu du portail (structure validée sur les maquettes), filtré selon les sections autorisées. */
function menu(sections: string[]): NavGroup[] {
  const has = (s: string) => sections.includes(s);
  const groups: NavGroup[] = [
    { items: [{ label: 'Accueil', to: '/' }] },
    has('operations') && {
      label: 'Opérations',
      items: ['Transactions', 'Services cartes', 'GAB', 'Commerçants et TPE', 'Affiliation e-commerce', 'Accès SmartVista'].map((label) => ({ label, soon: LOT4 })),
    },
    (has('demandes') || has('litiges')) && {
      label: 'Demandes et litiges',
      items: [has('demandes') && { label: 'Mes demandes', to: '/demandes' }, has('litiges') && { label: 'Litiges', to: '/litiges' }].filter(Boolean),
    },
    has('developpeurs') && {
      label: 'Développeurs',
      items: [
        { label: 'Catalogue', to: '/catalogue' },
        { label: 'Mises en service', to: '/mises-en-service' },
        { label: 'Identifiants', soon: LOT5 },
        { label: 'Sandbox', soon: LOT4 },
      ],
    },
    {
      label: 'Ressources',
      items: [{ label: 'Bibliothèque', soon: LOT5 }, { label: 'Assistant IA', soon: LOT5 }, has('demandes') ? { label: 'Support', to: '/demandes/nouvelle?type=SUPPORT' } : { label: 'Support', soon: LOT5 }],
    },
    has('compte') && {
      label: 'Compte',
      items: [{ label: 'Consommation et facturation', to: '/compte/consommation' }, { label: 'Gestion des accès', soon: LOT5 }],
    },
  ].filter(Boolean) as NavGroup[];
  return groups;
}

export function App() {
  const me = useMe();
  const has = (s: string) => me.sections.includes(s);
  return (
    <Routes>
      <Route element={<AppShell brand="Portail SMT" menuLabel="Menu du portail" groups={menu(me.sections)} context={<span className="pill pill-accent">{me.partner.name}</span>} />}>
        <Route index element={<Accueil />} />
        {has('demandes') && (
          <>
            <Route path="demandes" element={<DemandesListe />} />
            <Route path="demandes/nouvelle" element={<DemandeNouvelle />} />
            <Route path="demandes/:id" element={<DemandeDetail />} />
          </>
        )}
        {has('litiges') && (
          <>
            <Route path="litiges" element={<LitigesListe />} />
            <Route path="litiges/nouveau" element={<LitigeNouveau />} />
            <Route path="litiges/:id" element={<LitigeDetail />} />
          </>
        )}
        {has('developpeurs') && (
          <>
            <Route path="catalogue" element={<Catalogue />} />
            <Route path="mises-en-service" element={<MisesEnServiceListe />} />
            <Route path="mises-en-service/:id" element={<MiseEnServiceDetail />} />
          </>
        )}
        {has('compte') && <Route path="compte/consommation" element={<Consommation />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
