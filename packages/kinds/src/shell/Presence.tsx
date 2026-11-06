import { Avatar, cn, Tooltip } from "@texera/ui";
import { presenceTone } from "../live/presence";
import { usePresence } from "../live/room";

/** The ring of a person's icon, by their tone: literal names, so the stylesheet has them. */
export const PRESENCE_RING = ["ring-presence-1", "ring-presence-2", "ring-presence-3", "ring-presence-4", "ring-presence-5", "ring-presence-6"];

const SHOWN = 5;

/** The people on a resource right now, at the top right of its page: one icon each, the person's own first. */
export function Presence({ rid }: { rid: string }) {
  const people = usePresence(rid);
  if (people.length === 0) return null;
  const more = people.length - SHOWN;
  return (
    <ul className="flex shrink-0 items-center gap-1.5 px-1" aria-label="People here now" data-presence={people.length}>
      {people.slice(0, SHOWN).map(p => (
        <li key={p.pid} aria-label={p.self ? `${p.name} (you)` : p.name} data-present={p.pid}>
          <Tooltip content={p.self ? `${p.name} (you)` : p.name} side="bottom">
            <span className="block rounded-full">
              <Avatar name={p.name} className={cn("ring-2", PRESENCE_RING[presenceTone(p.pid)])} />
            </span>
          </Tooltip>
        </li>
      ))}
      {more > 0 && (
        <li className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground">+{more}</li>
      )}
    </ul>
  );
}
