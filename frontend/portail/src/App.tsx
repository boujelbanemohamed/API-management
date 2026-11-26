import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, NavGroup, NotificationsBell } from '@smt/ui';
import { useMe } from './session';
import { Accueil } from './pages/Accueil';
import { DemandesListe, DemandeNouvelle, DemandeDetail } from './pages/Demandes';
import { LitigesListe, LitigeNouveau, LitigeDetail } from './pages/Litiges';
import { MisesEnServiceListe, MiseEnServiceDetail } from './pages/MisesEnService';
import { Catalogue } from './pages/Catalogue';
import { Consommation } from './pages/Consommation';
import { Bibliotheque, ContenuDetail } from './pages/Contenus';
import { GestionAcces } from './pages/Acces';
import { AccesSmartVista, Affiliation, Commercants, Gab, ServicesCartes, Transactions } from './pages/Operations';

const LOT4 = 'Disponible au lot 5';
const LOT5 = 'Disponible au lot 5';

/** Menu du portail (structure validée sur les maquettes), filtré selon les sections autorisées. */
function menu(sections: string[], roles: string[]): NavGroup[] {
  const admin = roles.includes('banque-admin-securite');
  const has = (s: string) => sections.includes(s);
  const groups: NavGroup[] = [
    { items: [{ label: 'Accueil', to: '/' }] },
    has('operations') && {
      label: 'Opérations',
      items: [
        { label: 'Transactions', to: '/operations/transactions' },
        { label: 'Services cartes', to: '/operations/cartes' },
        { label: 'GAB', to: '/operations/gab' },
        { label: 'Commerçants et TPE', to: '/operations/commercants' },
        { label: 'Affiliation e-commerce', to: '/operations/affiliation' },
        { label: 'Accès SmartVista', to: '/operations/smartvista' },
      ],
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
      items: [{ label: 'Bibliothèque', to: '/bibliotheque' }, { label: 'Assistant IA', soon: LOT5 }, has('demandes') ? { label: 'Support', to: '/demandes/nouvelle?type=SUPPORT' } : { label: 'Support', soon: LOT5 }],
    },
    has('compte') && {
      label: 'Compte',
      items: [{ label: 'Consommation et facturation', to: '/compte/consommation' }, ...(admin ? [{ label: 'Gestion des accès', to: '/compte/acces' }] : [])],
    },
  ].filter(Boolean) as NavGroup[];
  return groups;
}

export function App() {
  const me = useMe();
  const has = (s: string) => me.sections.includes(s);
  return (
    <Routes>
      <Route element={<AppShell brand="Portail SMT" menuLabel="Menu du portail" groups={menu(me.sections, me.roles)} context={<><NotificationsBell base="/portal/notifications" /><span className="pill pill-accent">{me.partner.name}</span></>} />}>
        <Route index element={<Accueil />} />
        {has('operations') && (
          <>
            <Route path="operations/transactions" element={<Transactions />} />
            <Route path="operations/cartes" element={<ServicesCartes />} />
            <Route path="operations/gab" element={<Gab />} />
            <Route path="operations/commercants" element={<Commercants />} />
            <Route path="operations/affiliation" element={<Affiliation />} />
            <Route path="operations/smartvista" element={<AccesSmartVista />} />
          </>
        )}
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
        {me.roles.includes('banque-admin-securite') && <Route path="compte/acces" element={<GestionAcces />} />}
        <Route path="bibliotheque" element={<Bibliotheque />} />
        <Route path="contenus/:id" element={<ContenuDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
