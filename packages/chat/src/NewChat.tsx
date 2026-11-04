import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentTemplateSpec, Resource } from "@texera/catalog-client/types";
import { createResource, settingsQuery, unitsQuery } from "@texera/kinds";
import { Button, ErrorNote, Select } from "@texera/ui";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { TemplatePicker } from "./TemplatePicker";

/**
 * The start of a chat: pick an agent template and a computing unit; the conversation
 * becomes a catalog resource whose spec names the template its turns run.
 */
export function NewChat({ greeting, onCreated }: { greeting: string; onCreated: (rid: string) => void }) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQuery());
  const [picked, setPicked] = useState<Resource>();
  const { data: units } = useQuery(unitsQuery());
  const [unit, setUnit] = useState<string>();
  const chosenUnit = unit ?? units?.find(u => u.status?.phase === "ready")?.metadata.uri ?? units?.[0]?.metadata.uri;
  const template = picked?.metadata.uri ?? settings?.spec.defaults.agentTemplate;
  const create = useMutation({
    mutationFn: async () => {
      if (!template) throw new Error("Pick an agent template.");
      const name = picked ? (picked.spec as unknown as AgentTemplateSpec).card?.name || picked.metadata.name : "Chat";
      // Names are unique per project and kind, so the chat is named by its agent and its start.
      const started = new Date().toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const conversation = await createResource("conversation", { name: `${name}, ${started}`, spec: { template, ...(chosenUnit ? { computingUnit: chosenUnit } : {}) } });
      return conversation.metadata.rid;
    },
    onSuccess: rid => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      onCreated(rid);
    },
  });
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6" data-new-chat>
      <div className="flex flex-col items-center gap-3">
        <img src="/texera-mark.png" alt="" className="size-14" />
        <h1 className="text-center text-3xl font-semibold tracking-tight">{greeting}</h1>
        <p className="text-sm text-muted-foreground">Pick an agent to start with. You can switch agents in the chat, and an agent may hand the chat to another.</p>
      </div>
      <TemplatePicker value={template} onChange={setPicked} />
      <div className="flex flex-wrap items-center justify-center gap-2">
        {units && units.length > 0 && (
          <Select aria-label="Computing unit" value={chosenUnit ?? null} onChange={setUnit} options={units.map(u => ({ value: u.metadata.uri, label: u.metadata.name }))} className="w-48" />
        )}
        <Button onClick={() => create.mutate()} disabled={!template || create.isPending} data-start-chat>
          {create.isPending && <Loader2 className="animate-spin" />} Start chat
        </Button>
      </div>
      {create.error && <ErrorNote error={create.error} prefix="Could not start the chat" />}
    </div>
  );
}
