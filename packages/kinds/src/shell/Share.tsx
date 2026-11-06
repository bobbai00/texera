import { useQuery } from "@tanstack/react-query";
import { Button, DialogContent, DialogRoot, Input, Skeleton, Tooltip } from "@texera/ui";
import { Check, Link2, Users } from "lucide-react";
import { useState } from "react";
import { resourceQuery } from "../queries";
import { KINDS } from "../registry";
import type { ResourceRef } from "../types";
import { href } from "../uri";
import { Access } from "./Access";
import { useIsBuiltIn } from "./builtin";

/**
 * Sharing a resource, from its page: its link, and who it is shared with. The link opens the
 * page for whoever may read the resource; sharing is what lets them.
 */
export function ShareButton({ ref }: { ref: ResourceRef }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Share" side="bottom">
        <Button variant="ghost" size="icon-sm" aria-label="Share" onClick={() => setOpen(true)} data-share>
          <Users />
        </Button>
      </Tooltip>
      <DialogRoot open={open} onOpenChange={setOpen}>
        {open && <ShareDialog ref={ref} />}
      </DialogRoot>
    </>
  );
}

function ShareDialog({ ref }: { ref: ResourceRef }) {
  const { data: resource } = useQuery(resourceQuery(ref.rid));
  const isBuiltIn = useIsBuiltIn();
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}${href(ref)}`;
  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <DialogContent
      title={`Share ${resource ? `"${resource.metadata.name}"` : `this ${KINDS[ref.kind].label.toLowerCase()}`}`}
      description="The link opens this page for the people it is shared with."
      className="max-w-xl">
      <div className="space-y-4" data-share-dialog>
        <div className="flex items-center gap-2">
          <Input readOnly value={link} aria-label="Link" className="font-mono text-xs" onFocus={e => e.currentTarget.select()} data-share-link />
          <Button variant="outline" onClick={() => void copy()} data-copy-link>
            {copied ? <Check /> : <Link2 />} {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        {resource ? <div className="-mx-4 rounded-xl border"><Access resource={resource} builtIn={isBuiltIn(resource)} /></div> : <Skeleton className="h-32" />}
      </div>
    </DialogContent>
  );
}
