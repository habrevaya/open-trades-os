/**
 * The signed in technician, as the phone keeps it.
 *
 * Plain data and a parser, kept apart from the Keychain code so it can be
 * tested: a session written by an older version of the app, or half written
 * when the phone died, must read as "not signed in" and send the person to
 * the sign in screen, never crash the app on launch.
 */
export interface Session {
  serverUrl: string;
  token: string;
  expiresAt: string;
  deviceId: string;
  userId: string;
  email: string;
  name: string | null;
  organizationName: string;
  timezone: string;
}

export function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const text = ["serverUrl", "token", "expiresAt", "deviceId", "userId", "email", "organizationName", "timezone"];
  for (const key of text) if (typeof v[key] !== "string" || v[key] === "") return null;
  if (v["name"] !== null && typeof v["name"] !== "string") return null;
  return v as unknown as Session;
}

/** A token past its date is not tried, so the person is asked to sign in before a send fails. */
export function sessionExpired(session: Session, now: Date = new Date()): boolean {
  return new Date(session.expiresAt).getTime() <= now.getTime();
}

/** The installation id the server sees: this install, for this person. */
export function deviceInstallationId(installation: string, userId: string): string {
  return `${installation}:${userId}`;
}
