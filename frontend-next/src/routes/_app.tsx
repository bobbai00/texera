import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { AppShell } from "@/app/AppShell";
import { currentUser, useSession } from "@/auth/session";

// Every page except sign-in lives under this layout and requires a session. `panel` names the
// resource open beside the page, so a link reopens the same view.
export const Route = createFileRoute("/_app")({
  validateSearch: (search: Record<string, unknown>): { panel?: string } => ({
    panel: typeof search.panel === "string" && search.panel ? search.panel : undefined,
  }),
  beforeLoad: ({ location }) => {
    if (!currentUser()) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: SignedIn,
});

function SignedIn() {
  const user = useSession();
  return user ? <AppShell /> : <Navigate to="/login" />;
}
