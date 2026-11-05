import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createResource, settingsQuery, unitsQuery } from "@texera/kinds";
import { Button, ErrorNote, Select } from "@texera/ui";
import { Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * The start of a chat. Every chat runs the deployment's agent (the settings' default template);
 * the person picks only the computing unit the chat's runs use. The conversation becomes a
 * catalog resource whose spec names both.
 */
export function NewChat({ greeting, onCreated }: { greeting: string; onCreated: (rid: string) => void }) {
  const queryClient = useQueryClient();
  const { data: settings, error: settingsError } = useQuery(settingsQuery());
  const { data: units } = useQuery(unitsQuery());
  const [unit, setUnit] = useState<string>();
  const chosenUnit = unit ?? units?.find(u => u.status?.phase === "ready")?.metadata.uri ?? units?.[0]?.metadata.uri;
  const agent = settings?.spec.defaults.agentTemplate;
  const create = useMutation({
    mutationFn: async () => {
      if (!agent) throw new Error("This deployment has no agent.");
      // Names are unique per project and kind, so the chat is named by its start.
      const started = new Date().toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const conversation = await createResource("conversation", { name: `Chat, ${started}`, spec: { template: agent, ...(chosenUnit ? { computingUnit: chosenUnit } : {}) } });
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
        <p className="text-center text-sm text-muted-foreground">Ask about your data or the literature, or attach a CSV in the chat. Runs in the chat use the computing unit you pick here.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {units && units.length > 0 && (
          <Select aria-label="Computing unit" value={chosenUnit ?? null} onChange={setUnit} options={units.map(u => ({ value: u.metadata.uri, label: u.metadata.name }))} className="w-48" />
        )}
        <Button onClick={() => create.mutate()} disabled={!agent || create.isPending} data-start-chat>
          {create.isPending && <Loader2 className="animate-spin" />} Start chat
        </Button>
      </div>
      {settingsError && <ErrorNote error={settingsError} prefix="Could not load the settings" />}
      {create.error && <ErrorNote error={create.error} prefix="Could not start the chat" />}
    </div>
  );
}
