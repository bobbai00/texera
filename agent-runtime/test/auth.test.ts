import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AuthError, bearerToken, createServiceTokenSource, createUserTokenVerifier } from "../src/auth/index.ts";

const ISSUER = "http://localhost:8088/auth/realms/texera";

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  return { privateKey, getKey: createLocalJWKSet({ keys: [jwk] }) };
}

async function sign(privateKey: CryptoKey, claims: Record<string, unknown>, exp = "10m") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
}

describe("user token verification", () => {
  test("accepts a token from the issuer with the audience", async () => {
    const { privateKey, getKey } = await keys();
    const verify = createUserTokenVerifier({ issuer: ISSUER, audience: "texera", getKey });
    const token = await sign(privateKey, { iss: ISSUER, aud: "texera", sub: "alice-sub", preferred_username: "alice" });
    const identity = await verify(token);
    expect(identity.subject).toBe("alice-sub");
    expect(identity.token).toBe(token);
    expect(identity.claims.preferred_username).toBe("alice");
  });

  test("rejects the wrong audience, the wrong issuer, an expired token and garbage", async () => {
    const { privateKey, getKey } = await keys();
    const verify = createUserTokenVerifier({ issuer: ISSUER, audience: "texera", getKey, clockTolerance: 0 });
    const wrongAud = await sign(privateKey, { iss: ISSUER, aud: "other", sub: "x" });
    const wrongIss = await sign(privateKey, { iss: "http://evil", aud: "texera", sub: "x" });
    const expired = await sign(privateKey, { iss: ISSUER, aud: "texera", sub: "x" }, "-1m");
    for (const bad of [wrongAud, wrongIss, expired, "not.a.jwt"]) {
      await expect(verify(bad)).rejects.toBeInstanceOf(AuthError);
    }
  });

  test("rejects a token signed by another key", async () => {
    const { getKey } = await keys();
    const other = await keys();
    const verify = createUserTokenVerifier({ issuer: ISSUER, audience: "texera", getKey });
    const token = await sign(other.privateKey, { iss: ISSUER, aud: "texera", sub: "x" });
    await expect(verify(token)).rejects.toBeInstanceOf(AuthError);
  });

  test("bearerToken parses the header", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("service token source", () => {
  test("requests a client-credentials token and caches it until near expiry", async () => {
    let now = 1_000_000;
    let requests = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests += 1;
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("texera-services");
      return new Response(JSON.stringify({ access_token: `tok-${requests}`, expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const source = createServiceTokenSource({
      tokenUrl: "http://idp/token",
      clientId: "texera-services",
      clientSecret: "s",
      fetch: fetchImpl,
      refreshMargin: 10,
      now: () => now,
    });
    expect(await source.get()).toBe("tok-1");
    expect(await source.get()).toBe("tok-1");
    now += 55_000; // inside the refresh margin
    expect(await source.get()).toBe("tok-2");
    expect(requests).toBe(2);
    source.invalidate();
    expect(await source.get()).toBe("tok-3");
  });

  test("surfaces identity provider failures", async () => {
    const source = createServiceTokenSource({
      tokenUrl: "http://idp/token",
      clientId: "c",
      clientSecret: "s",
      fetch: async () => new Response("nope", { status: 401 }),
    });
    await expect(source.get()).rejects.toThrow(/401/);
  });
});
