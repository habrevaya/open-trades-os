import { FieldApi, normalizeServerUrl, type FieldApiOptions, type SignInResult } from "@opentradesos/field-client";
import { deviceInstallationId, type Session } from "./session";

/**
 * SIGNING THE PHONE IN, START TO FINISH
 *
 * Three steps against the company's own server: check the address, sign in
 * with an email and a password or a one time code for a device token, and
 * register this phone with that token, which binds the token to the device
 * so the office can take the phone away later. Kept out of the screens, with `fetch` injected,
 * so the whole sequence is tested without a phone.
 */
export interface DeviceFacts {
  installation: string;
  platform: "ios" | "android";
  label: string;
  appVersion?: string | undefined;
  osVersion?: string | undefined;
}

export type SignInOutcome =
  | { ok: true; session: Session; lastSequence: number }
  | { ok: false; error: string; field?: "server" | "email" | "password" | "code" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signInPhone(
  input: { server: string; email: string; password: string },
  device: DeviceFacts,
  fetcher?: FieldApiOptions["fetch"],
): Promise<SignInOutcome> {
  const checked = check(input);
  if (!checked.ok) return checked;
  if (input.password === "") return { ok: false, error: "Enter your password.", field: "password" };

  return attempt(async () => {
    const signed = await new FieldApi(options(checked.url, undefined, fetcher)).signIn({
      email: checked.email, password: input.password,
    });
    return finish(checked.url, signed, device, fetcher);
  });
}

/**
 * Ask for a one time code, by text to the mobile number the office has for
 * this person or by email. The server answers the same sentence whether or not
 * the address belongs to anybody, and the phone shows it as it comes.
 */
export async function requestPhoneCode(
  input: { server: string; email: string; channel: "sms" | "email" },
  fetcher?: FieldApiOptions["fetch"],
): Promise<{ ok: true; message: string } | { ok: false; error: string; field?: "server" | "email" }> {
  const checked = check(input);
  if (!checked.ok) return checked;
  try {
    const sent = await new FieldApi(options(checked.url, undefined, fetcher)).requestCode({
      email: checked.email, channel: input.channel,
    });
    return { ok: true, message: sent.message };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

/** The code in, then the same registration a password sign in does. */
export async function signInPhoneWithCode(
  input: { server: string; email: string; code: string },
  device: DeviceFacts,
  fetcher?: FieldApiOptions["fetch"],
): Promise<SignInOutcome> {
  const checked = check(input);
  if (!checked.ok) return checked;
  const code = input.code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Enter the six digit code from the text or email.", field: "code" };

  return attempt(async () => {
    const signed = await new FieldApi(options(checked.url, undefined, fetcher)).signInWithCode({
      email: checked.email, code,
    });
    return finish(checked.url, signed, device, fetcher);
  });
}

function check(input: { server: string; email: string }):
  | { ok: true; url: string; email: string }
  | { ok: false; error: string; field: "server" | "email" } {
  const server = normalizeServerUrl(input.server);
  if (!server.ok) return { ok: false, error: server.error, field: "server" };
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, error: "That does not look like an email address.", field: "email" };
  return { ok: true, url: server.url, email };
}

const options = (serverUrl: string, token?: string, fetcher?: FieldApiOptions["fetch"]): FieldApiOptions => ({
  serverUrl, ...(token ? { token } : {}), ...(fetcher ? { fetch: fetcher } : {}),
});

/**
 * Register this phone with the token just issued, which binds the token to
 * the device so the office can take the phone away, and keep what the app
 * needs. The same for a password and a code, so the two cannot disagree.
 */
async function finish(
  serverUrl: string, signed: SignInResult, device: DeviceFacts, fetcher?: FieldApiOptions["fetch"],
): Promise<SignInOutcome> {
  const registered = await new FieldApi(options(serverUrl, signed.token, fetcher)).register({
    installationId: deviceInstallationId(device.installation, signed.user.id),
    platform: device.platform,
    label: device.label.slice(0, 100),
    appVersion: device.appVersion,
    osVersion: device.osVersion,
  });
  return {
    ok: true,
    lastSequence: registered.lastSequence,
    session: {
      serverUrl,
      token: signed.token,
      expiresAt: signed.expiresAt,
      deviceId: registered.deviceId,
      userId: signed.user.id,
      email: signed.user.email,
      name: signed.user.name,
      organizationName: signed.organization.name,
      timezone: signed.organization.timezone,
    },
  };
}

async function attempt(run: () => Promise<SignInOutcome>): Promise<SignInOutcome> {
  try {
    return await run();
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

function failure(error: unknown): string {
  const offline = typeof error === "object" && error !== null && (error as { offline?: unknown }).offline === true;
  return offline
    ? "Could not reach that server. Check the address, and that this phone has signal."
    : error instanceof Error ? error.message : "Signing in did not work.";
}
