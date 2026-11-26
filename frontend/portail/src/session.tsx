import { createContext, ReactNode, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorBanner, Loading } from '@smt/ui';
import type { Me } from './types';

const MeContext = createContext<Me | null>(null);

/** Profil de l'utilisateur et de sa banque, lu une fois au démarrage (GET /portal/me). */
export function MeProvider({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/portal/me'), staleTime: 5 * 60_000 });
  if (me.isPending) return <Loading />;
  if (me.error) return <div className="content"><ErrorBanner error={me.error} /></div>;
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe hors de MeProvider');
  return me;
}

/** Droit d'écrire dans une section : mêmes règles que le back-end (auth/roles.ts). */
const WRITERS: Record<string, string[]> = {
  operations: ['banque-operateur-monetique'],
  demandes: ['banque-operateur-monetique', 'banque-developpeur', 'banque-gestionnaire-litiges'],
  litiges: ['banque-gestionnaire-litiges'],
  developpeurs: ['banque-developpeur'],
  compte: ['banque-facturation'],
};

export function useCan(section: string): boolean {
  const { roles } = useMe();
  return roles.includes('banque-admin-securite') || roles.some((r) => WRITERS[section]?.includes(r));
}
