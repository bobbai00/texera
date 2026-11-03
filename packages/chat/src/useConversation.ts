// One conversation: its persisted history plus the run streaming right now.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { conversationsMessagesOptions } from "@texera/catalog-client/query";
import type { ResourceRef } from "@texera/kinds";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { newRunId, runAgent } from "./agui/client";
import type { AgUiEvent, RunAgentInput } from "./agui/types";
import { applyEvent, type ChatMessage, type ChatState, EMPTY_STATE, fromHistory, resourcesOf } from "./model";

export interface Attachment {
  ref: ResourceRef;
  name: string;
}

export interface ConversationOptions {
  rid: string;
  /** The principal agent's pid; its AG-UI endpoint is `/agents/<pid>/ag-ui`. */
  agent: string | undefined;
  getToken: () => string | undefined;
  /** Called when a run ends, so the page can refresh what it produced. */
  onRunEnd?: () => void;
}

type LiveAction = { type: "event"; event: AgUiEvent } | { type: "user"; message: ChatMessage } | { type: "reset" } | { type: "fail"; message: string };

function liveReducer(state: ChatState, action: LiveAction): ChatState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "user":
      return { ...state, messages: [...state.messages, action.message], error: undefined };
    case "fail":
      return { ...state, running: false, error: action.message, messages: [...state.messages, { id: `err-${Date.now()}`, role: "assistant", parts: [{ type: "error", message: action.message }] }] };
    case "reset":
      return EMPTY_STATE;
  }
}

export function useConversation({ rid, agent, getToken, onRunEnd }: ConversationOptions) {
  const queryClient = useQueryClient();
  const history = useQuery({ ...conversationsMessagesOptions({ path: { rid }, query: { limit: 500 } }), staleTime: 10_000 });
  const [live, dispatch] = useReducer(liveReducer, EMPTY_STATE);
  const [baseline, setBaseline] = useState<number>();
  const abort = useRef<AbortController>(null);

  const persisted = useMemo(() => fromHistory(history.data ?? []), [history.data]);
  const maxSeq = history.data?.at(-1)?.seq ?? 0;

  // Once the catalog has the turn the stream showed, the persisted copy replaces the live one.
  useEffect(() => {
    if (baseline !== undefined && !live.running && maxSeq > baseline) {
      dispatch({ type: "reset" });
      setBaseline(undefined);
    }
  }, [baseline, live.running, maxSeq]);

  const messages = useMemo(() => [...persisted, ...live.messages], [persisted, live.messages]);
  const resources = useMemo(() => {
    const seen = new Set<string>();
    return [...resourcesOf(persisted), ...live.resources].filter(r => {
      const k = `${r.kind}:${r.rid}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [persisted, live.resources]);

  const send = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (!agent) throw new Error("This chat has no agent yet.");
      const messageId = crypto.randomUUID();
      const content = [text, ...attachments.map(a => `Attached ${a.ref.kind} "${a.name}" (${a.ref.kind}:${a.ref.rid}${a.ref.vno !== undefined ? `@${a.ref.vno}` : ""})`)]
        .filter(Boolean)
        .join("\n");
      dispatch({
        type: "user",
        message: {
          id: messageId,
          role: "user",
          parts: [...(text ? [{ type: "text" as const, text }] : []), ...attachments.map(a => ({ type: "resource" as const, ref: a.ref }))],
        },
      });
      setBaseline(maxSeq);
      const controller = new AbortController();
      abort.current = controller;
      const input: RunAgentInput = {
        threadId: rid,
        runId: newRunId(),
        messages: [{ id: messageId, role: "user", content }],
        tools: [],
        context: [],
        forwardedProps: { conversation: rid, attachments: attachments.map(a => a.ref) },
      };
      try {
        await runAgent({ url: `/agents/${encodeURIComponent(agent)}/ag-ui`, input, token: getToken(), signal: controller.signal, onEvent: event => dispatch({ type: "event", event }) });
      } catch (e) {
        if (!controller.signal.aborted) dispatch({ type: "fail", message: e instanceof Error ? e.message : String(e) });
      } finally {
        abort.current = null;
        await queryClient.invalidateQueries({ queryKey: [{ _id: "conversationsMessages", path: { rid } }] });
        queryClient.invalidateQueries({ queryKey: [{ _id: "conversationsResources", path: { rid } }] });
        queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
        queryClient.invalidateQueries({ queryKey: ["workflow-content"] });
        onRunEnd?.();
      }
    },
    [agent, rid, maxSeq, getToken, queryClient, onRunEnd]
  );

  const stop = useCallback(() => {
    abort.current?.abort();
    dispatch({ type: "event", event: { type: "RUN_FINISHED", threadId: rid, runId: live.runId ?? "" } });
  }, [rid, live.runId]);

  return {
    messages,
    resources,
    running: live.running,
    steps: live.steps,
    state: live.state,
    error: live.error,
    loading: history.isPending,
    historyError: history.error,
    send,
    stop,
  };
}
