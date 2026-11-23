import { createRemoteJWKSet, JWTPayload, jwtVerify, JWTVerifyGetKey } from 'jose';

/** Contenu utile d'un jeton Keycloak. */
export interface Identity {
  username: string;
  /** Client OIDC qui a obtenu le jeton : « console » ou « portail ». */
  client: string;
  roles: string[];
  /** Code de la banque (utilisateurs du portail uniquement). */
  partnerCode: string | null;
}

export interface TokenVerifier {
  /** Vérifie signature, émetteur et expiration ; lève une erreur sinon. */
  verify(token: string): Promise<Identity>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

export function toIdentity(payload: JWTPayload): Identity {
  const p = payload as JWTPayload & {
    preferred_username?: string;
    azp?: string;
    realm_access?: { roles?: string[] };
    partner_code?: string;
  };
  return {
    username: p.preferred_username ?? p.sub ?? 'inconnu',
    client: p.azp ?? '',
    roles: p.realm_access?.roles ?? [],
    partnerCode: p.partner_code ?? null,
  };
}

/**
 * Vérification des jetons Keycloak par les clés publiques du royaume (JWKS, mises en cache par jose).
 * `jwksUrl` peut différer de l'émetteur : l'émetteur est l'adresse vue par le navigateur,
 * le JWKS est lu par l'adresse interne du réseau des conteneurs.
 */
export class KeycloakTokenVerifier implements TokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly issuer: string, jwksUrl: string, keys?: JWTVerifyGetKey) {
    this.keys = keys ?? createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  }

  async verify(token: string): Promise<Identity> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.issuer,
      algorithms: ['RS256'],
      clockTolerance: 30,
    });
    return toIdentity(payload);
  }
}
