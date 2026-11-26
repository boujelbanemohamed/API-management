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
    // Fournisseur indisponible (503) : le back-end nomme le fournisseur et propose une demande.
    const fromBackend = res.status === 409 || res.status === 400 || (res.status === 503 && body.code === 'PROVIDER_UNAVAILABLE');
    const message = fromBackend ? (detail ?? 'Requête refusée.') : (MESSAGES[res.status] ?? 'Le service est momentanément indisponible.');
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

/** Téléchargement authentifié : le navigateur reçoit le fichier sans exposer le jeton dans une URL. */
export async function download(path: string, filename: string): Promise<void> {
  const token = await tokenProvider();
  const res = await fetch(baseUrl + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, undefined, MESSAGES[res.status] ?? 'Téléchargement impossible.');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Lit un fichier choisi par l'utilisateur et l'encode en base64 pour l'envoi. */
export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    r.readAsDataURL(file);
  });
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
