import { ResourceCard } from "@texera/kinds";
import { memo } from "react";
import type { ChatMessage } from "./model";
import { ApprovalPart, ErrorPart, ReasoningPart, SubagentPart, TextPart, ToolCallPart } from "./parts";

/** One message. Memoized on the message object so earlier messages never re-render while a reply streams. */
export const MessageItem = memo(function MessageItem({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  if (message.role === "user") {
    const texts = message.parts.filter(p => p.type === "text");
    const resources = message.parts.filter(p => p.type === "resource");
    return (
      <div className="space-y-2" data-message-role="user">
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
  if (message.role === "system") return null;
  return (
    <div className="space-y-3 text-sm leading-relaxed" data-message-role={message.role}>
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        switch (part.type) {
          case "text":
            return <TextPart key={key} text={part.text} streaming={streaming && i === message.parts.length - 1} />;
          case "reasoning":
            return <ReasoningPart key={key} text={part.text} />;
          case "tool":
            return <ToolCallPart key={key} part={part} />;
          case "resource":
            return <ResourceCard key={key} ref={part.ref} />;
          case "subagent":
            return <SubagentPart key={key} part={part} />;
          case "approval":
            return <ApprovalPart key={key} part={part} />;
          case "error":
            return <ErrorPart key={key} message={part.message} />;
          default:
            return null;
        }
      })}
    </div>
  );
});
