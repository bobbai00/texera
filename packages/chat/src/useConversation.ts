// One conversation: its persisted history plus the turn streaming right now.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { conversationsListMessagesOptions } from "@texera/catalog-client/query";
import { type ResourceRef, uriOf } from "@texera/kinds";
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
  /** The template the conversation runs now (its spec), so streamed replies are labelled before the catalog confirms them. */
  template: string | undefined;
  getToken: () => string | undefined;
  /** Called when a turn ends, so the page can refresh what it produced. */
  onRunEnd?: () => void;
}

type LiveAction = { type: "event"; event: AgUiEvent } | { type: "user"; message: ChatMessage; template?: string } | { type: "reset" } | { type: "fail"; message: string };

function liveReducer(state: ChatState, action: LiveAction): ChatState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "user":
      return { ...state, messages: [...state.messages, action.message], error: undefined, template: action.template };
    case "fail":
      return { ...state, running: false, error: action.message, messages: [...state.messages, { id: `err-${Date.now()}`, role: "assistant", parts: [{ type: "error", message: action.message }] }] };
    case "reset":
      return EMPTY_STATE;
  }
}

/** The AG-UI endpoint of a conversation on the agent runtime, behind the gateway. */
export const agUiUrl = (rid: string) => `/agents/conversations/${encodeURIComponent(rid)}/ag-ui`;

export function useConversation({ rid, template, getToken, onRunEnd }: ConversationOptions) {
  const queryClient = useQueryClient();
  const history = useQuery({ ...conversationsListMessagesOptions({ path: { rid }, query: { limit: 500 } }), staleTime: 10_000 });
  const [live, dispatch] = useReducer(liveReducer, EMPTY_STATE);
  const [baseline, setBaseline] = useState<number>();
  const abort = useRef<AbortController>(null);

  const persisted = useMemo(() => fromHistory(history.data?.items ?? []), [history.data]);
  const maxSeq = history.data?.items.at(-1)?.seq ?? 0;

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
      const messageId = crypto.randomUUID();
      const content = [text, ...attachments.map(a => `Attached ${a.ref.kind} "${a.name}" (${uriOf(a.ref)})`)].filter(Boolean).join("\n");
      dispatch({
        type: "user",
        message: { id: messageId, role: "user", parts: [...(text ? [{ type: "text" as const, text }] : []), ...attachments.map(a => ({ type: "resource" as const, ref: a.ref }))] },
        template,
      });
      setBaseline(maxSeq);
      const controller = new AbortController();
      abort.current = controller;
      const input: RunAgentInput = { threadId: rid, runId: newRunId(), messages: [{ id: messageId, role: "user", content }], tools: [], context: [], forwardedProps: {} };
      try {
        await runAgent({ url: agUiUrl(rid), input, token: getToken(), signal: controller.signal, onEvent: event => dispatch({ type: "event", event }) });
      } catch (e) {
        if (!controller.signal.aborted) dispatch({ type: "fail", message: e instanceof Error ? e.message : String(e) });
      } finally {
        abort.current = null;
        await queryClient.invalidateQueries({ queryKey: [{ _id: "conversationsListMessages", path: { rid } }] });
        queryClient.invalidateQueries({ queryKey: [{ _id: "conversationsResources", path: { rid } }] });
        queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesSearch" }] });
        queryClient.invalidateQueries({ queryKey: ["resource", rid] });
        onRunEnd?.();
      }
    },
    [rid, template, maxSeq, getToken, queryClient, onRunEnd]
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
