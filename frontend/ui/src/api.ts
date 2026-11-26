/** Client HTTP du back-end : ajoute le jeton Keycloak, traduit les erreurs en messages lisibles. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type TokenProvider = () => Promise<string | undefined>;

let baseUrl = '/api';
let tokenProvider: TokenProvider = async () => undefined;

export function configureApi(options: { baseUrl?: string; token: TokenProvider }) {
  if (options.baseUrl) baseUrl = options.baseUrl;
  tokenProvider = options.token;
}

const MESSAGES: Record<number, string> = {
  401: 'Votre session a expiré. Reconnectez-vous.',
  403: 'Vous n’avez pas les droits pour cette action.',
  404: 'Élément introuvable.',
  429: 'Trop de requêtes. Réessayez dans un instant.',
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await tokenProvider();
  const res = await fetch(baseUrl + path, {
    method: init.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const body = (data ?? {}) as { code?: string; message?: string | string[] };
    const detail = Array.isArray(body.message) ? body.message.join(' ; ') : body.message;
    // Erreur métier (409) ou de saisie (400) : le message du back-end est fait pour l'utilisateur.
    const message = res.status === 409 || res.status === 400 ? (detail ?? 'Requête refusée.') : (MESSAGES[res.status] ?? 'Le service est momentanément indisponible.');
    throw new ApiError(res.status, body.code, message);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
