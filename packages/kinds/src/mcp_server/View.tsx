import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mcpServersUpdateSpec } from "@texera/catalog-client";
import type { McpServerSpec } from "@texera/catalog-client/types";
import { Badge, Button, Chip, ErrorNote, Field, Input, NativeSelect, Skeleton, Tab, TabPanel, Tabs, TabsList, timeAgo } from "@texera/ui";
import { Check, History, Loader2, Plus, Settings2, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { unwrap } from "../api";
import { KindHeader } from "../shell/KindHeader";
import { JsonBlock } from "../shell/JsonBlock";
import { metaLine } from "../shell/MetaLine";
import { Versions } from "../shell/Versions";
import type { KindViewProps } from "../types";
import { mcpServerQuery } from "./spec";

/** An MCP server an agent may plug in: where it is, how to reach it, and the tools it exposed last time. */
export default function McpServerView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(mcpServerQuery(ref.rid));
  const [tab, setTab] = useState("edit");
  if (error) return <ErrorNote error={error} prefix="Could not open this server" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-mcp-server-view={ref.rid}>
      <KindHeader
        ref={{ kind: "mcp_server", rid: ref.rid }}
        mode={mode}
        name={data.metadata.name}
        meta={metaLine(data.metadata)}
        actions={
          data.status?.reachable !== undefined ? (
            <Badge tone={data.status.reachable ? "success" : "danger"}>
              {data.status.reachable ? "reachable" : "unreachable"}
              {data.status.lastChecked ? ` · ${timeAgo(data.status.lastChecked)}` : ""}
            </Badge>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="edit">
            <Settings2 /> Server
          </Tab>
          <Tab value="versions">
            <History /> Versions
          </Tab>
          <Tab value="json">JSON</Tab>
        </TabsList>
        <TabPanel value="edit" className="scrollbar-thin overflow-y-auto">
          <ServerForm key={data.metadata.headVersion} rid={ref.rid} spec={data.spec} tools={data.status?.tools ?? []} />
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

function ServerForm({ rid, spec, tools }: { rid: string; spec: McpServerSpec; tools: string[] }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<McpServerSpec>(() => structuredClone(spec));
  const [headers, setHeaders] = useState<[string, string][]>(() => Object.entries(spec.headers ?? {}));
  const ids = { transport: useId(), url: useId(), command: useId() };
  const next: McpServerSpec = { ...draft, headers: headers.length ? Object.fromEntries(headers.filter(([k]) => k.trim())) : undefined };
  const save = useMutation({
    mutationFn: () => unwrap(mcpServersUpdateSpec({ path: { rid }, body: next })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "mcpServersRead", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesListVersions", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "mcpServersList" }] });
    },
  });
  const dirty = JSON.stringify(next) !== JSON.stringify(spec);
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={e => {
        e.preventDefault();
        save.mutate();
      }}
      data-mcp-server-form>
      <Field label="Transport" htmlFor={ids.transport}>
        <NativeSelect id={ids.transport} value={draft.transport} onChange={e => setDraft({ ...draft, transport: e.target.value as McpServerSpec["transport"] })} className="w-full">
          <option value="streamable_http">Streamable HTTP</option>
          <option value="stdio">stdio (inside the agent's sandbox)</option>
        </NativeSelect>
      </Field>
      {draft.transport === "streamable_http" ? (
        <Field label="URL" required htmlFor={ids.url}>
          <Input id={ids.url} value={draft.url ?? ""} placeholder="https://example.org/mcp" onChange={e => setDraft({ ...draft, url: e.target.value })} />
        </Field>
      ) : (
        <Field label="Command" help="One argument per line." htmlFor={ids.command}>
          <textarea
            id={ids.command}
            className="control focus-ring block min-h-20 w-full p-2.5 font-mono text-xs"
            value={(draft.command ?? []).join("\n")}
            onChange={e => setDraft({ ...draft, command: e.target.value.split("\n").filter(Boolean) })}
          />
        </Field>
      )}
      <Field label="Headers" help="Sent on every request; a value `secret:<name>` is resolved by the runtime.">
        <div className="space-y-1.5">
          {headers.map(([k, v], i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <div key={i} className="flex gap-1.5">
              <Input value={k} placeholder="Authorization" className="h-8 text-xs" onChange={e => setHeaders(headers.map((h, j) => (j === i ? [e.target.value, h[1]] : h)))} />
              <Input value={v} placeholder="Bearer secret:bio-mcp" className="h-8 text-xs" onChange={e => setHeaders(headers.map((h, j) => (j === i ? [h[0], e.target.value] : h)))} />
              <Button variant="ghost" size="icon-sm" aria-label="Remove header" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="xs" onClick={() => setHeaders([...headers, ["", ""]])}>
            <Plus /> Add a header
          </Button>
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-primary" checked={!!draft.builtin} onChange={e => setDraft({ ...draft, builtin: e.target.checked || undefined })} />
        The built-in Texera MCP server (mounted at the gateway's /mcp)
      </label>
      {tools.length > 0 && (
        <Field label="Tools seen at the last check">
          <div className="flex flex-wrap gap-1.5">
            {tools.map(t => (
              <Chip key={t}>{t}</Chip>
            ))}
          </div>
        </Field>
      )}
      {save.error && <ErrorNote error={save.error} prefix="Could not save" />}
      <Button type="submit" disabled={!dirty || save.isPending} data-save-mcp-server>
        {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save as new version
      </Button>
    </form>
  );
}
