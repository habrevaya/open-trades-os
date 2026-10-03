/**
 * Where to send somebody after they sign in, or null.
 *
 * Only a path on this site. A full address, a protocol relative `//host` or a
 * backslash trick is refused, because a sign in page that redirects wherever
 * its query string says is the open redirect every phishing kit looks for:
 * a real login page on a real domain that drops the victim on the attacker's.
 */
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f]/.test(value)) return null;
  return value.slice(0, 2000);
}
