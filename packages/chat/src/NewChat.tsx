import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSpec } from "@texera/catalog-client/types";
import { createResource, meQuery, newChatSettingsQuery, useScope } from "@texera/kinds";
import { ErrorNote } from "@texera/ui";
import { useState } from "react";
import { ChatSettingsBar, PassedOver } from "./ChatSettingsBar";
import { Composer } from "./Composer";
import { leaveFirstMessage } from "./pending";

/**
 * The start of a chat: say what you want. The chat is created in the project the person works
 * in when the first message is sent, and stores only what they chose here: nothing, unless
 * they picked another model, a computing unit or other add-ons.
 */
export function NewChat({ greeting, onCreated }: { greeting: string; onCreated: (rid: string) => void }) {
  const queryClient = useQueryClient();
  const scope = useScope();
  const { data: me } = useQuery(meQuery());
  // With every project in view, a chat starts in the person's own.
  const project = scope ?? me?.homeProject;
  const { data: settings, error: settingsError } = useQuery({ ...newChatSettingsQuery(project ?? ""), enabled: project !== undefined });
  const [choices, setChoices] = useState<ConversationSpec>({});
  const [files, setFiles] = useState<File[]>([]);
  const start = useMutation({
    mutationFn: async (first: { text: string; files: File[] }) => {
      // Names are unique per project and kind, so the chat is named by its start.
      const started = new Date().toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const conversation = await createResource("conversation", { name: `Chat, ${started}`, parent: project, spec: choices });
      leaveFirstMessage(conversation.metadata.rid, first);
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
        <p className="text-center text-sm text-muted-foreground">Ask about your data or the literature, or attach a CSV.</p>
      </div>
      <div className="space-y-2">
        <Composer
          busy={start.isPending}
          onSend={message =>
            start.mutateAsync(message).then(
              () => true,
              () => false
            )
          }
          onStop={() => undefined}
          files={files}
          onFilesChange={setFiles}
          autoFocus
          controls={<ChatSettingsBar settings={settings} choices={choices} onChange={setChoices} disabled={start.isPending} />}
        />
        <PassedOver settings={settings} />
      </div>
      {settingsError && <ErrorNote error={settingsError} prefix="Could not load what a chat runs with" />}
      {start.error && <ErrorNote error={start.error} prefix="Could not start the chat" />}
    </div>
  );
}
