import { Button, formatBytes, Tooltip } from "@texera/ui";
import { ArrowUp, MessageSquareText, Paperclip, Square, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useRef, useState } from "react";

interface Props {
  /** This person's own turn is streaming: the send button becomes a stop button. */
  busy: boolean;
  /** Nothing can be sent right now (someone else's turn runs); drafting stays possible. */
  disabled?: boolean;
  /** Resolves false when the message could not be sent, so the draft stays in the box. */
  onSend: (message: { text: string; files: File[] }) => Promise<boolean>;
  /**
   * Posts the draft as a note: said to the people in the chat, the agent is not asked. Given
   * where there is a chat to say it in; possible while someone else's turn runs.
   */
  onNote?: (message: { text: string; files: File[] }) => Promise<boolean>;
  onStop: () => void;
  files: File[];
  onFilesChange: (files: File[]) => void;
  autoFocus?: boolean;
  placeholder?: string;
  status?: string;
  /** What the chat runs with, shown in the box's foot: its agent, model, unit and add-ons. */
  controls?: ReactNode;
}

export function Composer({ busy, disabled = false, onSend, onNote, onStop, files, onFilesChange, autoFocus, placeholder, status, controls }: Props) {
  const [text, setText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const empty = !text.trim() && files.length === 0;

  /** Hands the draft over; it comes back into the box when it could not be sent. */
  const hand = async (to: (message: { text: string; files: File[] }) => Promise<boolean>) => {
    if (busy || empty) return;
    const draft = text;
    setText("");
    if (!(await to({ text: draft.trim(), files }))) setText(draft);
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!disabled) void hand(onSend);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  };

  return (
    <form
      onSubmit={submit}
      data-composer
      className="rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-[3px] focus-within:ring-ring/15">
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {files.map(f => (
            <span key={f.name} className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/50 py-1 pr-1 pl-2 text-xs">
              <Paperclip className="size-3.5 text-muted-foreground" />
              {f.name}
              <span className="text-muted-foreground">{formatBytes(f.size)}</span>
              <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label={`Remove ${f.name}`} onClick={() => onFilesChange(files.filter(x => x !== f))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        // biome-ignore lint/a11y/noAutofocus: the composer is the page's primary input
        autoFocus={autoFocus}
        placeholder={placeholder ?? "Ask Texera to find, analyze or build something…"}
        aria-label="Message"
        className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-1 p-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-attach-input
          onChange={e => {
            onFilesChange([...files, ...Array.from(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Button variant="ghost" size="icon-sm" onClick={() => fileInput.current?.click()} aria-label="Attach files">
          <Paperclip />
        </Button>
        {controls}
        {status && <span className="truncate text-xs text-muted-foreground">{status}</span>}
        <div className="flex-1" />
        {busy ? (
          <Button size="icon-sm" variant="secondary" onClick={onStop} aria-label="Stop generating">
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <>
            {onNote && (
              <Tooltip content="Post as a note: the people in this chat read it, the agent is not asked">
                <Button variant="ghost" size="icon-sm" disabled={empty} onClick={() => void hand(onNote)} aria-label="Post as a note" data-send-note>
                  <MessageSquareText />
                </Button>
              </Tooltip>
            )}
            <Button type="submit" size="icon-sm" disabled={disabled || empty} aria-label="Send message">
              <ArrowUp />
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
