// The deployment's settings: a singleton read through its own route, then the generic page.

import { useQuery } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { ErrorNote, Skeleton } from "@texera/ui";
import { Settings } from "lucide-react";
import { lazy } from "react";
import { settingsQuery } from "../queries";
import { ResourcePage } from "../shell/GenericView";
import type { KindSpec, KindViewProps } from "../types";

function SettingsView({ mode }: KindViewProps) {
  const { data, error } = useQuery(settingsQuery());
  if (error) return <ErrorNote error={error} prefix="Could not open the settings" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  const resource = data as unknown as Resource;
  return <ResourcePage resource={resource} ref={{ kind: "settings", rid: resource.metadata.rid }} mode={mode} />;
}

export const settingsKind: KindSpec = {
  kind: "settings",
  label: "Settings",
  plural: "Settings",
  icon: Settings,
  accent: "bg-kind-settings/12 text-kind-settings",
  View: lazy(() => Promise.resolve({ default: SettingsView })),
};
