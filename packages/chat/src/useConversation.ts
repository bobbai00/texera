// One conversation: its persisted history plus the turn streaming right now.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { conversationsListMessagesOptions } from "@texera/catalog-client/query";
import type { Message, MessagePage } from "@texera/catalog-client/types";
import { type ResourceRef, useWatch } from "@texera/kinds";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { newRunId, runAgent } from "./agui/client";
import type { AgUiEvent, RunAgentInput } from "./agui/types";
import { applyEvent, type ChatMessage, type ChatState, EMPTY_STATE, fromHistory, messageContent, resourcesOf, settled } from "./model";

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

type LiveAction = { type: "event"; event: AgUiEvent } | { type: "user"; message: ChatMessage; template?: string } | { type: "settle"; catalogHasTheError: boolean } | { type: "fail"; message: string };

function liveReducer(state: ChatState, action: LiveAction): ChatState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "user":
      return { ...state, messages: [...state.messages, action.message], error: undefined, template: action.template };
    case "fail":
      return { ...state, running: false, error: action.message, messages: [...state.messages, { id: `err-${Date.now()}`, role: "assistant", parts: [{ type: "error", message: action.message }] }] };
    case "settle":
      return settled(state, action.catalogHasTheError);
  }
}

/** A page of messages with one appended or rewritten, in seq order. */
export function upsertMessage(items: Message[], m: Message): Message[] {
  const i = items.findIndex(x => x.seq === m.seq);
  if (i >= 0) return items.map((x, j) => (j === i ? m : x));
  return [...items, m].sort((a, b) => a.seq - b.seq);
}

/** The AG-UI endpoint of a conversation on the agent runtime, behind the gateway. */
export const agUiUrl = (rid: string) => `/agents/conversations/${encodeURIComponent(rid)}/ag-ui`;

export function useConversation({ rid, template, getToken, onRunEnd }: ConversationOptions) {
  const queryClient = useQueryClient();
  const history = useQuery({ ...conversationsListMessagesOptions({ path: { rid }, query: { limit: 500 } }), staleTime: 10_000 });
  const [live, dispatch] = useReducer(liveReducer, EMPTY_STATE);
  const [baseline, setBaseline] = useState<number>();
  // True from the moment a message is sent until its request is over and the history re-read.
  const [inFlight, setInFlight] = useState(false);
  const abort = useRef<AbortController>(null);

  const persisted = useMemo(() => fromHistory(history.data?.items ?? []), [history.data]);
  const maxSeq = history.data?.items.at(-1)?.seq ?? 0;

  // This person's own turn is under way from the moment they send until its request is over and
  // the history re-read, not only while events stream: the box is busy for all of it.
  const running = live.running || inFlight;
  // The others in the chat: their messages and turns arrive through the conversation's event
  // stream. While this person's own turn is under way, what is on screen is the live reply; the
  // catalog's copy of it takes over when the turn ends (the refetch below).
  const seen = useRef({ maxSeq, running });
  seen.current = { maxSeq, running };
  useWatch(rid, {
    after: () => seen.current.maxSeq,
    onMessage: m => {
      if (seen.current.running) return;
      queryClient.setQueriesData<MessagePage>({ queryKey: [{ _id: "conversationsListMessages", path: { rid } }] }, page => (page ? { ...page, items: upsertMessage(page.items, m) } : page));
    },
  });

  // Once the turn's request is over and the catalog has the turn, its copy replaces the live one.
  // Not before: a message from someone else in the chat can arrive while this turn is starting,
  // and must not be taken for it.
  useEffect(() => {
    if (baseline !== undefined && !inFlight && maxSeq > baseline) {
      const turn = history.data?.items.filter(m => m.seq > baseline) ?? [];
      dispatch({ type: "settle", catalogHasTheError: turn.some(m => m.parts.some(p => p.type === "error")) });
      setBaseline(undefined);
    }
  }, [baseline, inFlight, maxSeq, history.data]);

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
      dispatch({
        type: "user",
        message: { id: messageId, role: "user", parts: [...(text ? [{ type: "text" as const, text }] : []), ...attachments.map(a => ({ type: "resource" as const, ref: a.ref }))] },
        template,
      });
      setBaseline(maxSeq);
      setInFlight(true);
      const controller = new AbortController();
      abort.current = controller;
      const input: RunAgentInput = { threadId: rid, runId: newRunId(), messages: [{ id: messageId, role: "user", content: messageContent(text, attachments) }], tools: [], context: [], forwardedProps: {} };
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
        setInFlight(false);
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
    running,
    steps: live.steps,
    state: live.state,
    error: live.error,
    loading: history.isPending,
    historyError: history.error,
    send,
    stop,
  };
}
