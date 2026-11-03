import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentTemplatesUpdateSpec } from "@texera/catalog-client";
import { mcpServersListOptions, skillsListOptions } from "@texera/catalog-client/query";
import type { AgentTemplateSpec, McpBinding } from "@texera/catalog-client/types";
import { Button, Chip, ErrorNote, Field, Input, NativeSelect, Select, Skeleton, Tab, TabPanel, Tabs, TabsList, Textarea } from "@texera/ui";
import { Check, History, Loader2, Plus, Settings2, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { unwrap } from "../api";
import { KindHeader } from "../shell/KindHeader";
import { JsonBlock } from "../shell/JsonBlock";
import { metaLine } from "../shell/MetaLine";
import { Versions } from "../shell/Versions";
import type { KindViewProps } from "../types";
import { templateQuery } from "./spec";

/** An agent template: its card, model, prompts, skills, MCP servers and sub-agent policy, editable. */
export default function AgentTemplateView({ ref, mode }: KindViewProps) {
  const { data, error } = useQuery(templateQuery(ref.rid));
  const [tab, setTab] = useState("edit");
  if (error) return <ErrorNote error={error} prefix="Could not open this template" className="m-4" />;
  if (!data) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-template-view={ref.rid}>
      <KindHeader ref={{ kind: "agent_template", rid: ref.rid }} mode={mode} name={data.metadata.name} meta={metaLine(data.metadata)} />
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="edit">
            <Settings2 /> Template
          </Tab>
          <Tab value="versions">
            <History /> Versions
          </Tab>
          <Tab value="json">JSON</Tab>
        </TabsList>
        <TabPanel value="edit" className="scrollbar-thin overflow-y-auto">
          <TemplateForm key={data.metadata.headVersion} rid={ref.rid} spec={data.spec} />
        </TabPanel>
        <TabPanel value="versions" className="scrollbar-thin overflow-y-auto">
          <Versions rid={ref.rid} head={data.metadata.headVersion} />
        </TabPanel>
        <TabPanel value="json" className="scrollbar-thin overflow-y-auto p-3">
          <JsonBlock value={data.spec} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

const LIFETIMES = ["conversation", "execution", "pinned"] as const;

export function TemplateForm({ rid, spec }: { rid: string; spec: AgentTemplateSpec }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentTemplateSpec>(() => structuredClone(spec));
  const { data: servers } = useQuery(mcpServersListOptions({ query: { limit: 100 } }));
  const { data: skills } = useQuery(skillsListOptions({ query: { limit: 100 } }));
  const ids = { name: useId(), description: useId(), model: useId(), system: useId(), objective: useId() };
  const save = useMutation({
    mutationFn: () => unwrap(agentTemplatesUpdateSpec({ path: { rid }, body: draft })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "agentTemplatesRead", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesListVersions", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: [{ _id: "agentTemplatesList" }] });
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(spec);
  const set = (change: (s: AgentTemplateSpec) => void) =>
    setDraft(s => {
      const next = structuredClone(s);
      change(next);
      return next;
    });
  const bindings = draft.tools?.mcp ?? [];
  const setBindings = (mcp: McpBinding[]) => set(s => {
    s.tools = { ...s.tools, mcp };
  });

  return (
    <form
      className="space-y-5 p-4"
      onSubmit={e => {
        e.preventDefault();
        save.mutate();
      }}
      data-template-form>
      <section className="space-y-3">
        <Field label="Name" required htmlFor={ids.name}>
          <Input id={ids.name} value={draft.card.name} onChange={e => set(s => { s.card.name = e.target.value; })} />
        </Field>
        <Field label="Description" help="What this mode is for; shown in the chat's mode picker." htmlFor={ids.description}>
          <Textarea id={ids.description} rows={2} value={draft.card.description} onChange={e => set(s => { s.card.description = e.target.value; })} />
        </Field>
        <Field label="Model" help="As the LLM gateway names it; empty means the deployment default." htmlFor={ids.model}>
          <Input
            id={ids.model}
            value={draft.model?.name ?? ""}
            placeholder="claude-haiku-5-5"
            onChange={e => set(s => { s.model = e.target.value ? { ...s.model, name: e.target.value } : undefined; })}
          />
        </Field>
      </section>
      <section className="space-y-3">
        <Field label="System prompt" htmlFor={ids.system}>
          <Textarea id={ids.system} rows={6} className="font-mono text-xs" value={draft.prompts?.system ?? ""} onChange={e => set(s => { s.prompts = { ...s.prompts, system: e.target.value }; })} />
        </Field>
        <Field label="Objective" htmlFor={ids.objective}>
          <Textarea id={ids.objective} rows={3} value={draft.prompts?.objective ?? ""} onChange={e => set(s => { s.prompts = { ...s.prompts, objective: e.target.value }; })} />
        </Field>
      </section>
      <section className="space-y-2">
        <Field label="Skills" help="Skill resources the agent loads (SKILL.md).">
          <div className="flex flex-wrap gap-1.5">
            {(draft.skills ?? []).map(sk => (
              <Chip key={sk} onRemove={() => set(s => { s.skills = (s.skills ?? []).filter(x => x !== sk); })}>
                {skills?.items.find(k => k.metadata.rid === sk.split("@")[0])?.metadata.name ?? sk.slice(0, 8)}
              </Chip>
            ))}
            {skills && skills.items.length > 0 && (
              <NativeSelect
                aria-label="Add a skill"
                value=""
                onChange={e => {
                  const v = e.target.value;
                  if (v) set(s => { s.skills = [...(s.skills ?? []), v]; });
                }}>
                <option value="">Add a skill…</option>
                {skills.items
                  .filter(k => !(draft.skills ?? []).some(x => x.startsWith(k.metadata.rid)))
                  .map(k => (
                    <option key={k.metadata.rid} value={k.metadata.rid}>
                      {k.metadata.name}
                    </option>
                  ))}
              </NativeSelect>
            )}
          </div>
        </Field>
      </section>
      <section className="space-y-2">
        <Field label="MCP servers" help="Servers the agent may call, each with the tools it may use (all when empty).">
          <div className="space-y-2">
            {bindings.map((b, i) => (
              <div key={`${b.server}-${i}`} className="flex flex-wrap items-start gap-2 rounded-lg border p-2">
                <Select
                  aria-label="MCP server"
                  value={b.server || null}
                  onChange={v => setBindings(bindings.map((x, j) => (j === i ? { ...x, server: v } : x)))}
                  options={(servers?.items ?? []).map(s => ({ value: s.metadata.rid, label: s.metadata.name }))}
                  placeholder="Choose a server"
                  className="w-56"
                />
                <AllowList
                  value={b.allow ?? []}
                  known={servers?.items.find(s => s.metadata.rid === b.server)?.status?.tools ?? []}
                  onChange={allow => setBindings(bindings.map((x, j) => (j === i ? { ...x, allow: allow.length ? allow : undefined } : x)))}
                />
                <Button variant="ghost" size="icon-xs" aria-label="Remove server" onClick={() => setBindings(bindings.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="xs" onClick={() => setBindings([...bindings, { server: "" }])} data-add-mcp>
              <Plus /> Add an MCP server
            </Button>
          </div>
        </Field>
      </section>
      <section className="grid gap-3 sm:grid-cols-3">
        <Field label="Sub-agent lifetime">
          <NativeSelect
            value={draft.subagents?.lifetime ?? "conversation"}
            onChange={e => set(s => { s.subagents = { ...s.subagents, lifetime: e.target.value as (typeof LIFETIMES)[number] }; })}
            className="w-full">
            {LIFETIMES.map(l => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Max concurrent">
          <Input type="number" min={0} className="h-8 text-xs" value={draft.subagents?.maxConcurrent ?? ""} onChange={e => set(s => { s.subagents = { ...s.subagents, maxConcurrent: e.target.value === "" ? undefined : Number(e.target.value) }; })} />
        </Field>
        <Field label="Max depth">
          <Input type="number" min={0} className="h-8 text-xs" value={draft.subagents?.maxDepth ?? ""} onChange={e => set(s => { s.subagents = { ...s.subagents, maxDepth: e.target.value === "" ? undefined : Number(e.target.value) }; })} />
        </Field>
      </section>
      {save.error && <ErrorNote error={save.error} prefix="Could not save" />}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!dirty || save.isPending} data-save-template>
          {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save as new version
        </Button>
        {!dirty && <span className="text-xs text-muted-foreground">No changes.</span>}
      </div>
    </form>
  );
}

function AllowList({ value, known, onChange }: { value: string[]; known: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (name: string) => {
    const n = name.trim();
    if (n && !value.includes(n)) onChange([...value, n]);
    setDraft("");
  };
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {value.map(t => (
        <Chip key={t} onRemove={() => onChange(value.filter(x => x !== t))}>
          {t}
        </Chip>
      ))}
      <Input
        list={known.length ? "known-tools" : undefined}
        value={draft}
        placeholder={value.length ? "Add a tool" : "All tools"}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => add(draft)}
        className="h-7 w-40 text-xs"
      />
      {known.length > 0 && (
        <datalist id="known-tools">
          {known.map(t => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}
    </div>
  );
}
