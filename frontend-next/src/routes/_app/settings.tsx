import { createFileRoute } from "@tanstack/react-router";
import { ResourceView } from "@texera/kinds";

/** The deployment's settings: the one singleton, on its own page. */
export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

function SettingsPage() {
  return <ResourceView ref={{ kind: "settings", rid: "" }} mode="page" />;
}
