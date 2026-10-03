import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { parseSession, type Session } from "../lib/session";

/**
 * Who is signed in, kept in the Keychain on iOS and the Keystore on Android
 * rather than in the queue's database, because the token in it is a working
 * credential and SQLite on the phone is not encrypted.
 *
 * Readable after the first unlock since boot, not only while the phone is
 * unlocked, because the background task that sends the queue runs while it
 * is in a pocket.
 */
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const SESSION = "otos.session";
const INSTALLATION = "otos.installation";
/** What the sign in screen fills in next time, which is not a secret. */
const LAST = "otos.last-sign-in";

export async function loadSession(): Promise<Session | null> {
  return parseSession(await SecureStore.getItemAsync(SESSION, OPTIONS));
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(SESSION, JSON.stringify(session), OPTIONS);
  await SecureStore.setItemAsync(LAST, JSON.stringify({ serverUrl: session.serverUrl, email: session.email }), OPTIONS);
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION, OPTIONS);
}

export async function lastSignIn(): Promise<{ serverUrl: string; email: string } | null> {
  const raw = await SecureStore.getItemAsync(LAST, OPTIONS);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { serverUrl?: unknown; email?: unknown };
    return typeof parsed.serverUrl === "string" && typeof parsed.email === "string"
      ? { serverUrl: parsed.serverUrl, email: parsed.email }
      : null;
  } catch {
    return null;
  }
}

/**
 * This install's own id, made once. The server keys the device on it, so a
 * phone that signs out and back in carries on its sequence rather than
 * starting a new device at one.
 */
export async function installationId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(INSTALLATION, OPTIONS);
  if (existing) return existing;
  const fresh = Crypto.randomUUID();
  await SecureStore.setItemAsync(INSTALLATION, fresh, OPTIONS);
  return fresh;
}
