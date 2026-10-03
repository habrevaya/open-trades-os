import { FieldApi, normalizeServerUrl, type FieldApiOptions } from "@opentradesos/field-client";
import { deviceInstallationId, type Session } from "./session";

/**
 * SIGNING THE PHONE IN, START TO FINISH
 *
 * Three steps against the company's own server: check the address, sign in
 * with an email and password for a device token, and register this phone
 * with that token, which binds the token to the device so the office can
 * take the phone away later. Kept out of the screens, with `fetch` injected,
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
  | { ok: false; error: string; field?: "server" | "email" | "password" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signInPhone(
  input: { server: string; email: string; password: string },
  device: DeviceFacts,
  fetcher?: FieldApiOptions["fetch"],
): Promise<SignInOutcome> {
  const server = normalizeServerUrl(input.server);
  if (!server.ok) return { ok: false, error: server.error, field: "server" };
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, error: "That does not look like an email address.", field: "email" };
  if (input.password === "") return { ok: false, error: "Enter your password.", field: "password" };

  const options = (token?: string): FieldApiOptions => ({
    serverUrl: server.url, ...(token ? { token } : {}), ...(fetcher ? { fetch: fetcher } : {}),
  });

  try {
    const signed = await new FieldApi(options()).signIn({ email, password: input.password });
    const registered = await new FieldApi(options(signed.token)).register({
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
        serverUrl: server.url,
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
  } catch (error) {
    const offline = typeof error === "object" && error !== null && (error as { offline?: unknown }).offline === true;
    return {
      ok: false,
      error: offline
        ? "Could not reach that server. Check the address, and that this phone has signal."
        : error instanceof Error ? error.message : "Signing in did not work.",
    };
  }
}
