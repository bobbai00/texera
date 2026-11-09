import { Button, cn, Tooltip } from "@texera/ui";
import { Loader2, MessageCircle } from "lucide-react";
import type { ComponentProps } from "react";

/** The chat while it is out of the way: a round button in the corner of the page. */
export function ChatBubble({ label, working, className, ...button }: { label: string; working?: boolean } & ComponentProps<typeof Button>) {
  return (
    <Tooltip content={label} side="left">
      <Button size="icon" className={cn("size-12 rounded-full shadow-lg", className)} aria-label={label} {...button}>
        {working ? <Loader2 className="size-5 animate-spin" /> : <MessageCircle className="size-5" />}
      </Button>
    </Tooltip>
  );
}
