import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSpec } from "@texera/catalog-client/types";
import { createResource, newChatSettingsQuery, useDestination } from "@texera/kinds";
import { ErrorNote, Select } from "@texera/ui";
import { FolderKanban } from "lucide-react";
import { useState } from "react";
import { ChatSettingsBar, PassedOver } from "./ChatSettingsBar";
import { Composer } from "./Composer";
import { chatName, createNamed } from "./naming";
import { leaveFirstMessage } from "./pending";

/**
 * The start of a chat: say what you want. The chat is created in the project the person works
 * in when the first message is sent; with every project in view the box asks which, starting
 * from the one the page suggests. It stores only what the person chose here: nothing, unless
 * they picked another model, a computing unit or other add-ons. In the dock beside a page it
 * is the box alone, under a line that says what the chat is about.
 */
export function NewChat({
  greeting,
  onCreated,
  dock = false,
  about,
  suggested,
}: {
  greeting: string;
  onCreated: (rid: string) => void;
  dock?: boolean;
  about?: string;
  /** The project to start from when the person is asked: the one the page's resource is in. */
  suggested?: string;
}) {
  const queryClient = useQueryClient();
  const { project, asking, projects, choose } = useDestination(suggested);
  const { data: settings, error: settingsError } = useQuery({ ...newChatSettingsQuery(project ?? ""), enabled: project !== undefined });
  const [choices, setChoices] = useState<ConversationSpec>({});
  const [files, setFiles] = useState<File[]>([]);
  const start = useMutation({
    mutationFn: async (first: { text: string; files: File[] }) => {
      if (project === undefined) throw new Error("Choose the project this chat goes into first.");
      const conversation = await createNamed(chatName(about, new Date()), name => createResource("conversation", { name, parent: project, spec: choices }));
      leaveFirstMessage(conversation.metadata.rid, first);
      return conversation.metadata.rid;
    },
    onSuccess: rid => {
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
      onCreated(rid);
    },
  });
  // Asked only with every project in view: which project the chat goes into.
  const where = asking && (
    <span className="inline-flex items-center gap-1.5" data-chat-project={project ?? ""}>
      <FolderKanban className="size-3.5 text-muted-foreground" />
      <Select
        aria-label="Project for this chat"
        value={project ?? null}
        onChange={choose}
        options={projects}
        placeholder="Choose a project"
        className="max-w-44"
        disabled={start.isPending}
      />
    </span>
  );
  return (
    <div
      className={dock ? "flex h-full flex-col justify-end gap-3 p-3" : "mx-auto w-full max-w-2xl space-y-6"}
      data-new-chat
      data-new-chat-in={project ?? ""}>
      {dock ? (
        <p className="flex-1 content-center text-center text-sm text-muted-foreground">{greeting}</p>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <img src="/texera-mark.png" alt="" className="size-14" />
          <h1 className="text-center text-3xl font-semibold tracking-tight">{greeting}</h1>
          <p className="text-center text-sm text-muted-foreground">Ask about your data or the literature, or attach a CSV.</p>
        </div>
      )}
      <div className="space-y-2">
        <Composer
          busy={start.isPending}
          disabled={project === undefined}
          status={asking && project === undefined ? "Choose the project this chat goes into." : undefined}
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
          controls={
            dock ? (
              where || undefined
            ) : (
              <>
                {where}
                <ChatSettingsBar
                  settings={settings}
                  choices={choices}
                  onChange={setChoices}
                  disabled={start.isPending}
                />
              </>
            )
          }
        />
        <PassedOver settings={settings} />
      </div>
      {settingsError && <ErrorNote error={settingsError} prefix="Could not load what a chat runs with" />}
      {start.error && <ErrorNote error={start.error} prefix="Could not start the chat" />}
    </div>
  );
}
