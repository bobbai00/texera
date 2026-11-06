/**
 * Keeps a copy close behind something that changes fast: the catalog's copy of an answer while
 * it streams, which is what the others in a chat watch. One write at a time, so a newer state
 * never lands before an older one; whatever changes during a write is written after it, once.
 */
export interface Keeper {
  /** Something changed: the copy is written within the interval, once for however much changes meanwhile. */
  soon(): void;
  /** Brings the copy level with what there is now, after a write that is under way. */
  now(): Promise<void>;
  /** Drops a write that is still waiting: nothing more is written unless `now` is called. */
  stop(): void;
}

export function keeper(write: () => Promise<void>, everyMs: number): Keeper {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let again = false;
  const run = () => {
    writing = (async () => {
      try {
        do {
          again = false;
          await write();
        } while (again);
      } finally {
        writing = undefined;
      }
    })();
    return writing;
  };
  /** Writes the state there is now: by the write under way going round once more, or by a new one. */
  const level = () => {
    if (!writing) return run();
    again = true;
    return writing;
  };
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    soon() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void level();
      }, everyMs);
    },
    now() {
      stop();
      return level();
    },
    stop,
  };
}
