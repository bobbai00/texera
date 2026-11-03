import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsSpawn, conversationsCreate } from "@texera/catalog-client";
import type { AgentTemplate } from "@texera/catalog-client/types";
import { unitsQuery, unwrap } from "@texera/kinds";
import { Button, ErrorNote, Select } from "@texera/ui";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { ModePicker } from "./ModePicker";

export interface NewChatResult {
  rid: string;
  agent: string;
}

/**
 * The start of a chat: pick a mode (an agent template) and a computing unit; the
 * conversation becomes a catalog resource and its principal agent is spawned.
 */
export function NewChat({ greeting, onCreated }: { greeting: string; onCreated: (chat: NewChatResult, firstMessage?: string) => void }) {
  const queryClient = useQueryClient();
  const [template, setTemplate] = useState<AgentTemplate>();
  const { data: units } = useQuery(unitsQuery());
  const [unit, setUnit] = useState<string>();
  const chosenUnit = unit ?? units?.find(u => u.status?.phase === "ready")?.metadata.rid ?? units?.[0]?.metadata.rid;
  const create = useMutation({
    mutationFn: async (t: AgentTemplate) => {
      const ref = { rid: t.metadata.rid, vno: t.metadata.headVersion };
      const conversation = await unwrap(
        conversationsCreate({ body: { name: `${t.spec.card.name || t.metadata.name} chat`, spec: { template: ref, computingUnit: chosenUnit } } })
      );
      const agent = await unwrap(agentsSpawn({ body: { template: ref, conversation: conversation.metadata.rid, lifetime: "conversation" } }));
      return { rid: conversation.metadata.rid, agent: agent.pid };
    },
    onSuccess: chat => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "conversationsList" }] });
      onCreated(chat);
    },
  });
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6" data-new-chat>
      <div className="flex flex-col items-center gap-3">
        <img src="/texera-mark.png" alt="" className="size-14" />
        <h1 className="text-center text-3xl font-semibold tracking-tight">{greeting}</h1>
        <p className="text-sm text-muted-foreground">Pick a mode to start. Each mode is an agent template with its own tools and skills.</p>
      </div>
      <ModePicker value={template?.metadata.rid} onChange={setTemplate} />
      <div className="flex flex-wrap items-center justify-center gap-2">
        {units && units.length > 0 && (
          <Select
            aria-label="Computing unit"
            value={chosenUnit ?? null}
            onChange={setUnit}
            options={units.map(u => ({ value: u.metadata.rid, label: u.metadata.name }))}
            className="w-48"
          />
        )}
        <Button onClick={() => template && create.mutate(template)} disabled={!template || create.isPending} data-start-chat>
          {create.isPending && <Loader2 className="animate-spin" />} Start chat
        </Button>
      </div>
      {create.error && <ErrorNote error={create.error} prefix="Could not start the chat" />}
    </div>
  );
}
