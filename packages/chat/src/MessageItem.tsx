import { KindIcon, PrincipalName, ResourceCard } from "@texera/kinds";
import { memo } from "react";
import { type ChatMessage, visibleParts } from "./model";
import { ErrorPart, HandoffPart, ReasoningPart, TextPart, ToolCallPart } from "./parts";
import type { TemplateLabel } from "./templates";

/**
 * One message. Memoized on the message object so earlier messages never re-render while a
 * reply streams. An assistant message is labelled with the template version that wrote it.
 */
export const MessageItem = memo(function MessageItem({
  message,
  streaming,
  labels,
  showLabel,
  showAuthor = false,
}: {
  message: ChatMessage;
  streaming: boolean;
  labels: Map<string, TemplateLabel>;
  /** Whether to show the template label: the first message of a run of the same template. */
  showLabel: boolean;
  /** Whether to name the person who wrote a user message: someone else in a shared chat. */
  showAuthor?: boolean;
}) {
  if (message.role === "user") {
    const texts = message.parts.filter(p => p.type === "text");
    const resources = message.parts.filter(p => p.type === "resource");
    return (
      <div className="space-y-2" data-message-role="user">
        {showAuthor && message.author && (
          <div className="flex justify-end text-2xs font-medium tracking-wide text-muted-foreground uppercase" data-message-author={message.author}>
            <PrincipalName pid={message.author} />
          </div>
        )}
        {texts.length > 0 && (
          <div className="flex justify-end">
            <div className="max-w-[85%] space-y-2 rounded-2xl bg-secondary px-4 py-2.5 text-sm whitespace-pre-wrap">
              {texts.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
                <p key={i}>{p.text}</p>
              ))}
            </div>
          </div>
        )}
        {resources.map(p => (
          <div key={`${p.ref.kind}:${p.ref.rid}`} className="ml-auto max-w-[85%]">
            <ResourceCard ref={p.ref} />
          </div>
        ))}
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div data-message-role="system">
        {message.parts.map((part, i) => {
          const key = `${message.id}-${i}`;
          if (part.type === "handoff") return <HandoffPart key={key} part={part} toName={labels.get(part.to)?.name ?? part.name} fromName={part.from ? labels.get(part.from)?.name : undefined} />;
          if (part.type === "text") return <p key={key} className="py-1 text-center text-xs text-muted-foreground">{part.text}</p>;
          return null;
        })}
      </div>
    );
  }
  const label = message.template ? labels.get(message.template) : undefined;
  const parts = visibleParts(message.parts);
  return (
    <div className="space-y-3 text-sm leading-relaxed" data-message-role={message.role} data-template={label?.name}>
      {showLabel && label && (
        <div className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase" data-message-template={label.name}>
          <KindIcon kind="agent-template" className="size-5 rounded-md [&_svg]:size-3" />
          {label.name}
          {label.vno !== undefined && <span className="normal-case opacity-70">v{label.vno}</span>}
        </div>
      )}
      {parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        switch (part.type) {
          case "text":
            return <TextPart key={key} text={part.text} streaming={streaming && i === parts.length - 1} />;
          case "reasoning":
            return <ReasoningPart key={key} text={part.text} />;
          case "tool":
            return <ToolCallPart key={key} part={part} />;
          case "resource":
            return <ResourceCard key={key} ref={part.ref} />;
          case "handoff":
            return <HandoffPart key={key} part={part} toName={labels.get(part.to)?.name ?? part.name} />;
          case "error":
            return <ErrorPart key={key} message={part.message} />;
          default:
            return null;
        }
      })}
    </div>
  );
});
