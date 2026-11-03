import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { environmentsUpdateSpec } from "@texera/catalog-client";
import type { EnvironmentSpec } from "@texera/catalog-client/types";
import { Button, ErrorNote, Field, Input, Skeleton, Tab, TabPanel, Tabs, TabsList, Textarea } from "@texera/ui";
import { Check, History, Loader2, Settings2 } from "lucide-react";
import { useId, useState } from "react";
import { unwrap } from "../api";
import { KindHeader } from "../shell/KindHeader";
import { JsonBlock } from "../shell/JsonBlock";
import { metaLine } from "../shell/MetaLine";
import { Versions } from "../shell/Versions";
import type { KindViewProps } from "../types";
import { environmentQuery } from "./spec";

/** An environment: the Python packages (and base image) runs and sandboxes get. */
export default function EnvironmentView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(environmentQuery(ref.rid));
  const [tab, setTab] = useState("edit");
  if (error) return <ErrorNote error={error} prefix="Could not open this environment" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-environment-view={ref.rid}>
      <KindHeader ref={{ kind: "environment", rid: ref.rid }} mode={mode} name={data.metadata.name} meta={metaLine(data.metadata)} />
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="edit">
            <Settings2 /> Packages
          </Tab>
          <Tab value="versions">
            <History /> Versions
          </Tab>
          <Tab value="json">JSON</Tab>
        </TabsList>
        <TabPanel value="edit" className="scrollbar-thin overflow-y-auto">
          <EnvironmentForm key={data.metadata.headVersion} rid={ref.rid} spec={data.spec} />
        </TabPanel>
        <TabPanel value="versions" className="scrollbar-thin overflow-y-auto">
          <Versions rid={ref.rid} head={data.metadata.headVersion} />
        </TabPanel>
        <TabPanel value="json" className="scrollbar-thin overflow-y-auto p-3">
          <JsonBlock value={{ spec: data.spec, status: data.status }} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function EnvironmentForm({ rid, spec }: { rid: string; spec: EnvironmentSpec }) {
  const queryClient = useQueryClient();
  const [packages, setPackages] = useState(() => (spec.python?.packages ?? []).join("\n"));
  const [version, setVersion] = useState(spec.python?.version ?? "");
  const [image, setImage] = useState(spec.baseImage ?? "");
  const ids = { packages: useId(), version: useId(), image: useId() };
  const next: EnvironmentSpec = {
    python: { packages: packages.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")), ...(version.trim() ? { version: version.trim() } : {}) },
    ...(image.trim() ? { baseImage: image.trim() } : {}),
  };
  const save = useMutation({
    mutationFn: () => unwrap(environmentsUpdateSpec({ path: { rid }, body: next })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "environmentsRead", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesListVersions", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "environmentsList" }] });
    },
  });
  const dirty = JSON.stringify(next) !== JSON.stringify({ python: { packages: spec.python?.packages ?? [], ...(spec.python?.version ? { version: spec.python.version } : {}) }, ...(spec.baseImage ? { baseImage: spec.baseImage } : {}) });
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={e => {
        e.preventDefault();
        save.mutate();
      }}
      data-environment-form>
      <Field label="Python packages" help="PEP 508 requirement lines, one per line; built into a venv on the unit before a run." htmlFor={ids.packages}>
        <Textarea id={ids.packages} rows={8} className="font-mono text-xs" value={packages} onChange={e => setPackages(e.target.value)} placeholder={"pandas==2.2.3\nscikit-learn>=1.5"} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Python version" help="PEP 440 range, e.g. >=3.12,<3.13" htmlFor={ids.version}>
          <Input id={ids.version} value={version} onChange={e => setVersion(e.target.value)} className="h-8 text-xs" />
        </Field>
        <Field label="Base image" help="Empty means the deployment default." htmlFor={ids.image}>
          <Input id={ids.image} value={image} onChange={e => setImage(e.target.value)} className="h-8 text-xs" />
        </Field>
      </div>
      {save.error && <ErrorNote error={save.error} prefix="Could not save" />}
      <Button type="submit" disabled={!dirty || save.isPending} data-save-environment>
        {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save as new version
      </Button>
    </form>
  );
}
