import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/** The verified identity of the person calling the runtime. */
export interface UserIdentity {
  /** The OIDC subject. */
  subject: string;
  /** The raw bearer token, forwarded to the catalog so the user's permissions apply. */
  token: string;
  claims: JWTPayload & { preferred_username?: string; email?: string };
}

export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface UserTokenVerifierOptions {
  issuer: string;
  audience: string;
  /** Key source; defaults to a remote JWKS at `jwksUrl`. */
  getKey?: JWTVerifyGetKey;
  jwksUrl?: string;
  /** Allowed clock skew in seconds. */
  clockTolerance?: number;
}

export type UserTokenVerifier = (token: string) => Promise<UserIdentity>;

/** Builds a verifier for Keycloak-issued RS256 tokens. */
export function createUserTokenVerifier(options: UserTokenVerifierOptions): UserTokenVerifier {
  const getKey =
    options.getKey ??
    (() => {
      if (!options.jwksUrl) throw new Error("jwksUrl or getKey is required");
      return createRemoteJWKSet(new URL(options.jwksUrl));
    })();
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, {
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: options.clockTolerance ?? 30,
      }));
    } catch (err) {
      throw new AuthError(`invalid token: ${(err as Error).message}`);
    }
    if (!payload.sub) throw new AuthError("token has no subject");
    return { subject: payload.sub, token, claims: payload };
  };
}

/** Extracts the bearer token from an Authorization header value. */
export function bearerToken(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || undefined;
}
