import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { href, isKindId, KINDS, KindIcon, searchQuery } from "@texera/kinds";
import { Command } from "cmdk";
import { SquarePen } from "lucide-react";
import { useDeferredValue, useState } from "react";

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

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search Texera"
      shouldFilter={false}
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
        <Command.Group
          heading="Actions"
          className="text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          <Command.Item
            onSelect={() => go("/")}
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground data-[selected=true]:bg-accent">
            <SquarePen className="size-4" /> New chat
          </Command.Item>
        </Command.Group>
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
      </Command.List>
    </Command.Dialog>
  );
}
