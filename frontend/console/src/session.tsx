import { createContext, ReactNode, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorBanner, Loading } from '@smt/ui';

export interface ConsoleMe { username: string; roles: string[]; sections: string[] }
const Ctx = createContext<ConsoleMe | null>(null);

/** Profil et sections visibles (GET /console/me). */
export function MeProvider({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<ConsoleMe>('/console/me'), staleTime: 5 * 60_000 });
  if (me.isPending) return <Loading />;
  if (me.error) return <div className="content"><ErrorBanner error={me.error} /></div>;
  return <Ctx.Provider value={me.data}>{children}</Ctx.Provider>;
}

export function useMe(): ConsoleMe {
  const me = useContext(Ctx);
  if (!me) throw new Error('useMe hors de MeProvider');
  return me;
}

/** Droit d'écrire dans une section : mêmes règles que le back-end (auth/roles.ts). */
const WRITERS: Record<string, string[]> = {
  demandes: ['console-agent-operations', 'console-agent-integration', 'console-agent-securite', 'console-agent-support', 'console-agent-litiges'],
  litiges: ['console-agent-litiges', 'console-arbitre'],
  'mises-en-service': ['console-agent-integration'],
  banques: ['console-agent-integration', 'console-agent-securite'],
  catalogue: ['console-agent-integration'],
  finance: ['console-facturation'],
  administration: [],
};
export function useCan(section: string): boolean {
  const { roles } = useMe();
  return roles.includes('console-admin') || roles.some((r) => WRITERS[section]?.includes(r));
}
export function useHasRole(...roles: string[]): boolean {
  const me = useMe();
  return me.roles.includes('console-admin') || me.roles.some((r) => roles.includes(r));
}
