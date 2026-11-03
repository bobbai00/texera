import { createFileRoute, redirect } from "@tanstack/react-router";
import { Button } from "@texera/ui";
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
  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-card p-8 text-center shadow-sm" data-login>
        <img src="/texera-mark.png" alt="" className="mx-auto size-14" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Texera</h1>
          <p className="mt-1 text-sm text-muted-foreground">The workspace for agentic, collaborative data science.</p>
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
