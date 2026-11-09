import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { publicReadOptions } from "@texera/catalog-client/query";
import { Button, lookOf } from "@texera/ui";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { safeRedirect } from "@/auth/safe-redirect";
import { currentUser, signIn } from "@/auth/session";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: ({ search }) => {
    if (currentUser()) throw redirect({ to: search.redirect ?? "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect: to } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  // The deployment's own look, which the catalog says to anyone.
  const brand = useQuery({ ...publicReadOptions(), staleTime: 60_000 }).data?.branding;
  const logo = brand && lookOf(brand).logoLargeUrl;
  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-card p-8 text-center shadow-sm" data-login>
        {logo && <img src={logo} alt="" className="mx-auto size-20 object-contain" />}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{brand?.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{brand?.description || "The workspace for agentic, collaborative data science."}</p>
        </div>
        <Button
          className="w-full"
          size="lg"
          disabled={busy}
          data-sign-in
          onClick={() => {
            setBusy(true);
            void signIn(to);
          }}>
          <LogIn /> Sign in
        </Button>
        <p className="text-xs text-muted-foreground">You will be taken to your organization's sign-in page.</p>
      </div>
    </main>
  );
}
