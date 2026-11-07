import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { href, isKindId, KINDS, KindIcon, searchQuery } from "@texera/kinds";
import { Command } from "cmdk";
import { SquarePen } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";

const NEW_CHAT = "new chat";

/** ⌘K: jump to any resource the catalog finds, or start a new chat. */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim());
  const { data } = useQuery({ ...searchQuery({ q: q || undefined, limit: 50 }), enabled: open });

  const go = (to: string) => {
    onOpenChange(false);
    void navigate({ to });
  };
  const groups = new Map<string, NonNullable<typeof data>["items"]>();
  for (const r of data?.items ?? []) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);

  // Typed words look for something: what matches comes first, so Enter opens it; with
  // nothing typed the menu starts with what can be done.
  const searching = query.trim() !== "";
  // What is picked for Enter: the first match once the matches arrive (they come after the
  // words are typed, and the menu would keep what it picked before), else a new chat.
  const [picked, setPicked] = useState(NEW_CHAT);
  let firstMatch: string | undefined;
  for (const [kind, items] of groups) {
    const r = items[0];
    if (searching && q === query.trim() && isKindId(kind) && r && firstMatch === undefined)
      firstMatch = `${r.metadata.name} ${kind} ${r.metadata.rid}`;
  }
  useEffect(() => {
    setPicked(firstMatch ?? NEW_CHAT);
  }, [firstMatch]);
  const actions = (
    <Command.Group
      heading="Actions"
      className="text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
      <Command.Item
        value={NEW_CHAT}
        onSelect={() => go("/")}
        className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground data-[selected=true]:bg-accent">
        <SquarePen className="size-4" /> New chat
      </Command.Item>
    </Command.Group>
  );
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search Texera"
      shouldFilter={false}
      value={picked}
      onValueChange={setPicked}
      overlayClassName="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]"
      contentClassName="fixed top-[15vh] left-1/2 z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl">
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Search workflows, datasets, agents, chats…"
        className="h-12 w-full border-b bg-transparent px-4 text-sm outline-none"
      />
      <Command.List className="scrollbar-thin max-h-96 overflow-y-auto p-2">
        <Command.Empty className="py-6 text-center text-sm text-muted-foreground">No results.</Command.Empty>
        {!searching && actions}
        {[...groups.entries()].map(([kind, items]) =>
          isKindId(kind) ? (
            <Command.Group
              key={kind}
              heading={KINDS[kind].plural}
              className="text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {items.map(r => (
                <Command.Item
                  key={r.metadata.rid}
                  value={`${r.metadata.name} ${kind} ${r.metadata.rid}`}
                  onSelect={() => go(href({ kind, rid: r.metadata.rid, parent: r.metadata.parent }))}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-foreground data-[selected=true]:bg-accent">
                  <KindIcon kind={kind} className="size-6 [&_svg]:size-3.5" />
                  <span className="truncate">{r.metadata.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null
        )}
        {searching && actions}
      </Command.List>
    </Command.Dialog>
  );
}
