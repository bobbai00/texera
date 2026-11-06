// Small references: a URI as a chip that names what it points to and opens it beside, the
// origin of a resource (the chat turn that made it), who made something, and a principal's name.

import { useQuery } from "@tanstack/react-query";
import { principalsReadOptions } from "@texera/catalog-client/query";
import type { Origin } from "@texera/catalog-client/types";
import { cn } from "@texera/ui";
import { MessagesSquare } from "lucide-react";
import { resourceByUriQuery, resourceQuery } from "../queries";
import { KINDS } from "../registry";
import { parseUri, shortUri } from "../uri";
import { useOpenResource } from "./navigation";

/** A URI, shown by the name of what it names (resolved lazily), with its version and subresource. */
export function UriChip({ uri, emphasis, className }: { uri: string; emphasis?: boolean; className?: string }) {
  const parsed = parseUri(uri);
  const { beside } = useOpenResource();
  const { data } = useQuery({ ...resourceByUriQuery(uri), enabled: !!parsed && parsed.ref.kind !== "settings" });
  if (!parsed) return <ForeignChip uri={uri} className={className} />;
  const { ref, subresource } = parsed;
  const Icon = KINDS[ref.kind].icon;
  const name = data?.metadata.name ?? shortUri(uri).split("/").slice(0, 2).join("/");
  const tail = [ref.vno !== undefined ? `@${ref.vno}` : "", subresource ? ` · ${subresource.replace(/^files\//, "").replace(/^operators\/([^/]+)\/ports\/(.+)$/, "$1 / $2")}` : ""].join("");
  return (
    <button
      type="button"
      onClick={() => beside(data ? { ...ref, parent: data.metadata.parent } : ref)}
      title={uri}
      data-uri-chip={ref.kind}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-left text-xs hover:bg-accent",
        emphasis ? "font-medium" : "text-muted-foreground",
        className
      )}>
      <Icon className={cn("size-3 shrink-0", KINDS[ref.kind].accent.split(" ").find(c => c.startsWith("text-")))} />
      <span className="truncate">
        {name}
        {tail}
      </span>
    </button>
  );
}

/** A name outside the catalog, such as an Iceberg table an execution produced: its scheme as the label, the whole name on hover. */
function ForeignChip({ uri, className }: { uri: string; className?: string }) {
  const scheme = uri.split(":")[0] ?? "";
  const tail = uri.split("/").filter(Boolean).at(-1) ?? uri;
  return (
    <span title={uri} className={cn("inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground", className)} data-uri-chip={scheme}>
      <span className="font-medium">{scheme === "iceberg" ? "table" : scheme}</span>
      <code className="truncate text-2xs">{tail.length > 40 ? `${tail.slice(0, 40)}…` : tail}</code>
    </span>
  );
}

/** Where a resource or version came from: the chat that made it. */
export function OriginChip({ origin, className }: { origin: Origin; className?: string }) {
  const { beside } = useOpenResource();
  const { data: template } = useQuery({ ...resourceByUriQuery(origin.template ?? ""), enabled: !!origin.template });
  return (
    <button
      type="button"
      onClick={() => beside({ kind: "conversation", rid: origin.conversation })}
      className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-foreground", className)}
      title="Made in a chat"
      data-origin>
      <MessagesSquare className="size-3" /> {template ? `by ${template.metadata.name}` : "from a chat"}
    </button>
  );
}

/**
 * Who made something, as one sentence: "Made by Alice Liddell", or "Made by Texera Agent for Bob
 * Builder, in the chat iris ranks"; empty while there is nobody to say.
 */
export function useMadeBy(createdBy: string | undefined, origin: Origin | undefined) {
  const { data: person } = useQuery({
    ...principalsReadOptions({ path: { pid: createdBy ?? "" } }),
    staleTime: 10 * 60_000,
    enabled: !!createdBy,
  });
  const { data: agent } = useQuery({ ...resourceByUriQuery(origin?.template ?? ""), enabled: !!origin?.template });
  const { data: chat } = useQuery({ ...resourceQuery(origin?.conversation ?? ""), enabled: !!origin, retry: false });
  const who = person?.displayName ?? "…";
  const by = agent?.metadata.name ?? "the agent";
  const where = chat?.metadata.name;
  const said = !createdBy
    ? ""
    : origin
      ? `Made by ${by} for ${who}, in the chat ${where ?? "they were in"}`
      : `Made by ${who}`;
  return { said, who, by, where };
}

/**
 * Who made something, in a line: "by Alice Liddell", or, for what an agent made in a chat, "by"
 * the chat, a button that opens it beside and is cut short before it runs out of room. The whole
 * of it (the agent, and the person it worked for) is said on hover. A chat the reader may not
 * open is "a chat".
 */
export function MadeBy({
  createdBy,
  origin,
  prefix = "",
  className,
}: {
  createdBy: string;
  origin?: Origin;
  prefix?: string;
  className?: string;
}) {
  const { beside } = useOpenResource();
  const { said, who, where } = useMadeBy(createdBy, origin);
  if (!origin)
    return (
      <span className={cn("block truncate", className)} title={said} data-made-by="person">
        {prefix}by {who}
      </span>
    );
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)} title={said} data-made-by="agent">
      <span className="shrink-0">{prefix}by</span>
      {where ? (
        <button
          type="button"
          onClick={() => beside({ kind: "conversation", rid: origin.conversation })}
          className="nodrag nopan pointer-events-auto relative z-10 inline-flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline"
          data-made-in={origin.conversation}>
          <MessagesSquare className="size-3 shrink-0" />
          <span className="truncate">{where}</span>
        </button>
      ) : (
        <span className="truncate">a chat</span>
      )}
    </span>
  );
}

/** A principal's display name, by pid. */
export function PrincipalName({ pid, className }: { pid: string; className?: string }) {
  const { data } = useQuery({ ...principalsReadOptions({ path: { pid } }), staleTime: 10 * 60_000 });
  return <span className={className}>{data?.displayName ?? pid.slice(0, 8)}</span>;
}
