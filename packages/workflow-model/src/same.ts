type Json = Record<string, unknown>;

/** Whether two JSON values say the same, whatever the order of their keys. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => same(v, (b as unknown[])[i]));
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every(k => k in (b as Json) && same((a as Json)[k], (b as Json)[k]))
  );
}
