import Keycloak from 'keycloak-js';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { configureApi } from './api';

export interface AuthState {
  username: string;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth hors de AuthProvider');
  return ctx;
}

/**
 * Connexion Keycloak obligatoire (flux « authorization code » + PKCE), jeton rafraîchi avant chaque appel.
 * Configuration lue à l'exécution dans /config.json, pour une même image dans tous les environnements.
 */
/**
 * Initialisation unique par page : React (StrictMode) peut lancer l'effet deux fois ; deux `init`
 * concurrents se disputeraient le code de retour de Keycloak et provoqueraient une boucle de connexion.
 */
let session: Promise<AuthState> | null = null;

function startSession(clientId: string): Promise<AuthState> {
  session ??= (async () => {
    const cfg = (await fetch('/config.json').then((r) => r.json())) as { keycloakUrl: string; realm: string; apiUrl?: string };
    const kc = new Keycloak({ url: cfg.keycloakUrl, realm: cfg.realm, clientId });
    await kc.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false });
    configureApi({
      baseUrl: cfg.apiUrl,
      token: async () => {
        await kc.updateToken(30).catch(() => kc.login());
        return kc.token;
      },
    });
    return {
      username: (kc.tokenParsed?.preferred_username as string) ?? '',
      logout: () => kc.logout({ redirectUri: window.location.origin }),
    };
  })();
  return session;
}

export function AuthProvider({ clientId, children }: { clientId: string; children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    startSession(clientId)
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setError('Connexion impossible au service d’identité.'));
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (error) return <div className="content"><div className="banner banner-error" role="alert">{error}</div></div>;
  if (!state) return <div className="content" aria-busy="true">Connexion…</div>;
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

/** Pour les tests : fournit une session sans Keycloak. */
export function TestAuthProvider({ username = 'test', children }: { username?: string; children: ReactNode }) {
  return <AuthContext.Provider value={{ username, logout: () => undefined }}>{children}</AuthContext.Provider>;
}
