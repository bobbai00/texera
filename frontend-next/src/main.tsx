import "@texera/ui/styles/tokens.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { client } from "@texera/catalog-client";
import { CatalogError } from "@texera/kinds";
import { ToastProvider } from "@texera/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getAccessToken, initSession } from "./auth/session";
import { routeTree } from "./routeTree.gen";

// Every catalog call goes through the gateway on this origin with the session's token.
client.setConfig({ baseUrl: "/", auth: () => getAccessToken() });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Client errors (403, 404, ...) will not fix themselves; only retry server and network failures.
      retry: (count, error) => !(error instanceof CatalogError && error.status < 500) && count < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

initSession().then(() => {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>
  );
});
