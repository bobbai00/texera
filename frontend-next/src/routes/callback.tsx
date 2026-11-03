import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ErrorNote, Spinner } from "@texera/ui";
import { useEffect, useState } from "react";
import { safeRedirect } from "@/auth/safe-redirect";
import { completeSignIn } from "@/auth/session";

export const Route = createFileRoute("/callback")({ component: CallbackPage });

/** Where Keycloak sends the browser back; finishes the code exchange and goes on. */
function CallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    completeSignIn()
      .then(returnTo => navigate({ to: safeRedirect(returnTo) ?? "/", replace: true }))
      .catch(setError);
  }, [navigate]);
  return (
    <main className="flex h-full items-center justify-center p-6">
      {error !== undefined ? (
        <ErrorNote error={error} prefix="Sign-in did not complete" className="max-w-md" />
      ) : (
        <Spinner className="size-6" />
      )}
    </main>
  );
}
