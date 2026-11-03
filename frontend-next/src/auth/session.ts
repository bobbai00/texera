// The session: OpenID Connect against Keycloak (authorization code with PKCE) through
// oidc-client-ts. The access token lives in memory (oidc-client-ts keeps its state in
// sessionStorage for the tab); it is never written to localStorage or put in a URL.

import { type User, UserManager, WebStorageStateStore } from "oidc-client-ts";
import { useSyncExternalStore } from "react";

export interface SessionUser {
  sub: string;
  name: string;
  email?: string;
  expiresAt: number;
}

const origin = window.location.origin;

export const AUTHORITY = `${origin}/auth/realms/texera`;
export const CLIENT_ID = "texera-app";

const manager = new UserManager({
  authority: AUTHORITY,
  client_id: CLIENT_ID,
  redirect_uri: `${origin}/callback`,
  post_logout_redirect_uri: `${origin}/login`,
  response_type: "code",
  scope: "openid profile email",
  automaticSilentRenew: true,
  // Stays in the tab; cleared when it closes.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

let current: User | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
function set(user: User | null) {
  current = user && !user.expired ? user : null;
  notify();
}

manager.events.addUserLoaded(user => set(user));
manager.events.addUserUnloaded(() => set(null));
manager.events.addAccessTokenExpired(() => set(null));
manager.events.addSilentRenewError(() => set(null));

/** Restores the tab's session before the app renders. */
export async function initSession(): Promise<SessionUser | null> {
  try {
    set(await manager.getUser());
  } catch {
    set(null);
  }
  return currentUser();
}

export function getAccessToken(): string | undefined {
  return current && !current.expired ? current.access_token : undefined;
}

function toSessionUser(user: User): SessionUser {
  const p = user.profile;
  return {
    sub: p.sub,
    name: p.name ?? p.preferred_username ?? p.email ?? p.sub,
    email: p.email,
    expiresAt: (user.expires_at ?? 0) * 1000,
  };
}

export function currentUser(): SessionUser | null {
  return current && !current.expired ? toSessionUser(current) : null;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
let snapshotCache: { user: User | null; value: SessionUser | null } = { user: null, value: null };
function snapshot(): SessionUser | null {
  if (snapshotCache.user !== current) snapshotCache = { user: current, value: currentUser() };
  return snapshotCache.value;
}

export function useSession(): SessionUser | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Sends the browser to Keycloak; `returnTo` is where to land afterwards. */
export function signIn(returnTo?: string): Promise<void> {
  return manager.signinRedirect({ state: { returnTo: returnTo ?? "/" } });
}

/** Finishes the redirect flow on /callback; returns where to go. */
export async function completeSignIn(): Promise<string> {
  const user = await manager.signinRedirectCallback();
  set(user);
  const state = user.state as { returnTo?: string } | undefined;
  return state?.returnTo ?? "/";
}

export async function signOut(): Promise<void> {
  const user = current;
  set(null);
  await manager.removeUser();
  await manager.signoutRedirect({ id_token_hint: user?.id_token });
}
