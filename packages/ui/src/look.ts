// A look as it is drawn: a name, and a logo at two sizes, the mark standing in for one not given.

/** The mark of a project that has no logo of its own. */
export const MARK = "/texera-mark.png";

export function lookOf(branding: { name?: string; logoUrl?: string; logoLargeUrl?: string }) {
  const logoUrl = branding.logoUrl || MARK;
  return { name: branding.name ?? "", logoUrl, logoLargeUrl: branding.logoLargeUrl || logoUrl };
}
