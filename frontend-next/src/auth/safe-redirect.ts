/**
 * A post-login destination from a query string, kept to this app's own paths: no absolute
 * URLs, no protocol-relative URLs, no backslashes, no control characters.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being rejected
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}
