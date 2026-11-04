// An agent template's form: its card, model endpoint, prompt, skills, MCP servers, handoffs
// and loop. Saving writes a new version. Every reference is a URI picked from the catalog.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentTemplateSpec, McpBinding, McpServerStatus, Resource } from "@texera/catalog-client/types";
import { Button, Chip, ErrorNote, Field, Input, NativeSelect, Textarea } from "@texera/ui";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { updateSpec } from "../api";
import { keysOf, searchQuery } from "../queries";
import { StringList } from "../schema/SchemaForm";
import { baseUri } from "../uri";

const ANSWERS = ["free", "after_result"] as const;

export function TemplateForm({ resource, readonly = false }: { resource: Resource; readonly?: boolean }) {
  const rid = resource.metadata.rid;
  const spec = resource.spec as unknown as AgentTemplateSpec;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentTemplateSpec>(() => structuredClone(spec));
  const { data: endpoints } = useQuery(searchQuery({ kind: "model-endpoint" }));
  const { data: servers } = useQuery(searchQuery({ kind: "mcp-server" }));
  const { data: skills } = useQuery(searchQuery({ kind: "skill" }));
  const { data: templates } = useQuery(searchQuery({ kind: "agent-template" }));
  const ids = { name: useId(), description: useId(), model: useId(), prompt: useId(), answer: useId(), steps: useId(), temperature: useId() };
  const save = useMutation({
    mutationFn: () => updateSpec("agent-template", rid, { spec: draft, expectedHead: resource.metadata.head, message: "Edited in the app" }, resource.metadata.etag),
    onSuccess: () => {
      for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: [{ _id: "resolve" }] });
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(spec);
  const set = (change: (s: AgentTemplateSpec) => void) =>
    setDraft(s => {
      const next = structuredClone(s);
      change(next);
      return next;
    });
  const bindings = draft.mcpServers ?? [];
  const setBindings = (mcpServers: McpBinding[]) => set(s => {
    s.mcpServers = mcpServers.length ? mcpServers : undefined;
  });
  const others = (templates?.items ?? []).filter(t => t.metadata.rid !== rid);
  const nameOf = (list: Resource[] | undefined, uri: string) => list?.find(r => r.metadata.uri === baseUri(uri))?.metadata.name ?? uri;

  return (
    <form
      className="space-y-5 p-4"
      onSubmit={e => {
        e.preventDefault();
        save.mutate();
      }}
      data-template-form>
      <fieldset disabled={readonly} className="space-y-5">
        <section className="space-y-3">
          <Field label="Name" required htmlFor={ids.name} help="How the chat's template picker and other agents name it.">
            <Input id={ids.name} value={draft.card.name} onChange={e => set(s => { s.card.name = e.target.value; })} data-field="card.name" />
          </Field>
          <Field label="Description" required htmlFor={ids.description} help="What this agent is for; what other agents read before handing off to it.">
            <Textarea id={ids.description} rows={2} value={draft.card.description} onChange={e => set(s => { s.card.description = e.target.value; })} data-field="card.description" />
          </Field>
          <Field label="Model endpoint" required htmlFor={ids.model}>
            <NativeSelect id={ids.model} value={draft.model} onChange={e => set(s => { s.model = e.target.value; })} className="w-full" data-field="model">
              <option value="">Choose a model endpoint…</option>
              {(endpoints?.items ?? []).map(m => (
                <option key={m.metadata.rid} value={m.metadata.uri}>
                  {m.metadata.name}
                </option>
              ))}
              {draft.model && !endpoints?.items.some(m => m.metadata.uri === draft.model) && <option value={draft.model}>{draft.model}</option>}
            </NativeSelect>
          </Field>
        </section>
        <section className="space-y-3">
          <Field label="System prompt" required htmlFor={ids.prompt} help="Markdown. The skills index, the handoff candidates and the tool instructions are appended by the runtime.">
            <Textarea id={ids.prompt} rows={10} className="font-mono text-xs" value={draft.prompt} onChange={e => set(s => { s.prompt = e.target.value; })} data-field="prompt" />
          </Field>
        </section>
        <section className="space-y-2">
          <UriPicker
            label="Skills"
            help="Loaded on demand through load_skill; the agent sees their names and descriptions."
            value={draft.skills ?? []}
            options={skills?.items ?? []}
            onChange={v => set(s => { s.skills = v.length ? v : undefined; })}
            name="skills"
          />
        </section>
        <section className="space-y-2">
          <Field label="MCP servers" help="Servers the agent mounts, each with the tools it may use (every tool when empty). The catalog server is mounted unless turned off below.">
            <div className="space-y-2">
              {bindings.map((b, i) => (
                <div key={`${b.server}-${i}`} className="flex flex-wrap items-start gap-2 rounded-lg border p-2" data-mcp-binding>
                  <NativeSelect aria-label="MCP server" value={b.server} onChange={e => setBindings(bindings.map((x, j) => (j === i ? { ...x, server: e.target.value } : x)))} className="w-56">
                    <option value="">Choose a server…</option>
                    {(servers?.items ?? []).map(s => (
                      <option key={s.metadata.rid} value={s.metadata.uri}>
                        {s.metadata.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <AllowList
                    value={b.allow ?? []}
                    known={(servers?.items.find(s => s.metadata.uri === baseUri(b.server))?.status as McpServerStatus | undefined)?.tools ?? []}
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
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={draft.catalogTools !== false} onChange={e => set(s => { s.catalogTools = e.target.checked ? undefined : false; })} data-field="catalogTools" />
            Mount the catalog MCP server (search, read, share, create templates)
          </label>
        </section>
        <section className="space-y-2">
          <UriPicker
            label="Hands off to"
            help="Templates this agent may hand the conversation to when another one fits the person's request better."
            value={draft.handoffs ?? []}
            options={others}
            onChange={v => set(s => { s.handoffs = v.length ? v : undefined; })}
            name="handoffs"
          />
        </section>
        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="When a reply is the answer" htmlFor={ids.answer} help="free: always; after_result: only once a result-showing tool succeeded.">
            <NativeSelect id={ids.answer} value={draft.loop?.answer ?? ""} onChange={e => set(s => { s.loop = { ...s.loop, answer: (e.target.value || undefined) as (typeof ANSWERS)[number] | undefined }; })} className="w-full">
              <option value="">runtime default</option>
              {ANSWERS.map(a => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Result tools" help="Tools whose successful result counts as a shown result.">
            <StringList value={draft.loop?.resultTools ?? []} onChange={v => set(s => { s.loop = { ...s.loop, resultTools: v.length ? v : undefined }; })} name="resultTools" />
          </Field>
          <Field label="Max steps per turn" htmlFor={ids.steps}>
            <Input id={ids.steps} type="number" min={1} className="h-8 text-xs" value={draft.loop?.maxSteps ?? ""} onChange={e => set(s => { s.loop = { ...s.loop, maxSteps: e.target.value === "" ? undefined : Number(e.target.value) }; })} />
          </Field>
          <Field label="Temperature" htmlFor={ids.temperature}>
            <Input id={ids.temperature} type="number" min={0} max={1} step={0.1} className="h-8 text-xs" value={draft.loop?.temperature ?? ""} onChange={e => set(s => { s.loop = { ...s.loop, temperature: e.target.value === "" ? undefined : Number(e.target.value) }; })} />
          </Field>
        </section>
      </fieldset>
      {save.error && <ErrorNote error={save.error} prefix="Could not save" />}
      {!readonly && (
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!dirty || !draft.model || save.isPending} data-save-template>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save as new version
          </Button>
          {!dirty && <span className="text-xs text-muted-foreground">No changes.</span>}
          <span className="sr-only">{nameOf(endpoints?.items, draft.model)}</span>
        </div>
      )}
    </form>
  );
}

/** A list of resource URIs picked from a kind's resources. */
function UriPicker({ label, help, value, options, onChange, name }: { label: string; help?: string; value: string[]; options: Resource[]; onChange: (v: string[]) => void; name: string }) {
  const nameOf = (uri: string) => options.find(o => o.metadata.uri === baseUri(uri))?.metadata.name ?? uri;
  const free = options.filter(o => !value.some(v => baseUri(v) === o.metadata.uri));
  return (
    <Field label={label} help={help}>
      <div className="flex flex-wrap items-center gap-1.5" data-field={name}>
        {value.map(uri => (
          <Chip key={uri} onRemove={() => onChange(value.filter(x => x !== uri))}>
            {nameOf(uri)}
          </Chip>
        ))}
        {free.length > 0 && (
          <NativeSelect
            aria-label={`Add to ${label.toLowerCase()}`}
            value=""
            onChange={e => {
              if (e.target.value) onChange([...value, e.target.value]);
            }}>
            <option value="">Add…</option>
            {free.map(o => (
              <option key={o.metadata.rid} value={o.metadata.uri}>
                {o.metadata.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>
    </Field>
  );
}

function AllowList({ value, known, onChange }: { value: string[]; known: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const listId = useId();
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
        list={known.length ? listId : undefined}
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
        aria-label="Allowed tools"
      />
      {known.length > 0 && (
        <datalist id={listId}>
          {known.map(t => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}
    </div>
  );
}
