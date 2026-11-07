// What a chat runs with, in the chat box: the agent, its model and the add-on tools. It shows
// what the catalog resolves and writes a choice only when the person makes one, so a chat that
// was never touched keeps following its project's defaults, which may come from up the project's
// chain to Texera's. Where an
// execution runs is the run's to say, not the chat's.

import { useQuery } from "@tanstack/react-query";
import type { ChatSettings, ConversationSpec } from "@texera/catalog-client/types";
import { baseUri, KindIcon, searchQuery } from "@texera/kinds";
import { Button, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger, Select, type SelectOption } from "@texera/ui";
import { Blocks } from "lucide-react";
import { asOption, effective, WORK_MODES, withAddOn, withModel, withWorkMode } from "./settings";

export function ChatSettingsBar({
  settings,
  choices,
  onChange,
  disabled = false,
}: {
  /** What the catalog resolves for the chat, or for a chat not started yet. */
  settings: ChatSettings | undefined;
  /** The chat's own choices. */
  choices: ConversationSpec;
  onChange: (choices: ConversationSpec) => void;
  disabled?: boolean;
}) {
  const scope = settings?.project.rid;
  const ready = settings !== undefined;
  const { data: models } = useQuery({ ...searchQuery({ kind: "model-endpoint", scope }), enabled: ready });
  const { data: servers } = useQuery({ ...searchQuery({ kind: "mcp-server", scope }), enabled: ready });
  const now = effective(settings, choices);
  if (!settings || !now) return null;

  // The catalog's own server holds the basic tools and is always on; the rest are add-ons.
  const own = new Set(settings.mcpServers.filter(s => s.platform).map(s => s.uri));
  const addOns = (servers?.items ?? []).filter(s => !own.has(s.metadata.uri));
  // What is chosen stays listed even when the lists do not hold it (another project's).
  const named = (uri: string, known: SelectOption<string>[], fallback: string) =>
    known.some(o => o.value === baseUri(uri)) ? known : [...known, { value: baseUri(uri), label: fallback }];
  const modelOptions = named(now.model, (models?.items ?? []).map(asOption), settings.modelEndpoint.name);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-chat-settings>
      <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium" data-chat-agent={now.agent} title="The agent this chat runs">
        <KindIcon kind="agent-template" className="size-5 rounded-md [&_svg]:size-3" />
        {now.agent}
      </span>
      <Select aria-label="Model" value={baseUri(now.model)} onChange={uri => onChange(withModel(choices, uri))} options={modelOptions} disabled={disabled} className="max-w-44" />
      <Select aria-label="Changes" value={now.workMode} onChange={mode => onChange(withWorkMode(choices, mode))} options={WORK_MODES} disabled={disabled} className="max-w-32" data-work-mode={now.workMode} />
      <DropdownMenu>
        <DropdownMenuTrigger>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2 text-xs font-normal" disabled={disabled} data-chat-add-ons={now.addOns.length}>
            <Blocks className="size-3.5" /> Add-ons{now.addOns.length > 0 ? ` · ${now.addOns.length}` : ""}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" className="w-64">
          <DropdownMenuLabel>
            {settings.mcpServers
              .filter(s => s.platform)
              .map(s => s.name)
              .join(", ") || "No catalog server"}{" "}
            · always on
          </DropdownMenuLabel>
          {addOns.length === 0 && <DropdownMenuLabel>No add-on servers in this project.</DropdownMenuLabel>}
          {addOns.map(server => (
            <DropdownMenuCheckboxItem
              key={server.metadata.rid}
              checked={now.addOns.some(uri => baseUri(uri) === server.metadata.uri)}
              onCheckedChange={on => onChange(withAddOn(choices, settings, server.metadata.uri, on))}
              data-add-on={server.metadata.name}>
              <span className="min-w-0 flex-1 truncate">{server.metadata.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** What was passed over for this person: a choice of the chat they may not use. */
export function PassedOver({ settings }: { settings: ChatSettings | undefined }) {
  if (!settings?.skipped?.length) return null;
  const what = { template: "agent", modelEndpoint: "model", mcpServers: "add-on" } as const;
  return (
    <p className="text-xs text-muted-foreground" data-passed-over>
      {settings.skipped.map(s => `This chat's ${what[s.setting]} was passed over: ${s.reason}.`).join(" ")}
    </p>
  );
}
