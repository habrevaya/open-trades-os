import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ConflictError } from "./context";
/**
 * The barrel rather than the seam, so the Twilio adapter is registered by
 * whatever reaches this file.
 */
import { createVoiceProvider, voiceCapableProviders, type NumberWebhooks, type VoiceProvider } from "../voice/index";

/**
 * THE COMPANY'S CARRIER ACCOUNT, FOR CALLS
 *
 * What every part of calling needs before it can do anything: the deployment's
 * public address, the connection the company's texts already go through, and
 * the adapter that speaks to it. Kept apart from the call handling itself so
 * the browser phone's settings can reach the same account by the same rules
 * without importing the whole of a call.
 */


export type ReadSecret = (ref: string) => Promise<string>;

export interface VoiceDeps {
  readSecret: ReadSecret;
  /** Injected so no test reaches Twilio and no deployment fakes one. */
  provider?: VoiceProvider | undefined;
  /** The deployment's public address, which every webhook URL is built from. */
  publicBase?: string | undefined;
  /**
   * Where the carrier opens the phone assistant's WebSocket: the voice relay's
   * public address, `wss://` and a host. Read from VOICE_RELAY_URL when not
   * handed in, and absent when this installation runs no relay.
   */
  relayBase?: string | undefined;
}

export const relayBaseOf = (deps: VoiceDeps): string | undefined =>
  deps.relayBase ?? (process.env["VOICE_RELAY_URL"] || undefined);

const secretFromEnvironment: ReadSecret = async (ref) => {
  const value = process.env[ref];
  if (!value) {
    throw new ConflictError(
      `No carrier credential in the environment under "${ref}". The Twilio connection names that secret and nothing is set there.`,
    );
  }
  return value;
};

export const DEFAULT_DEPS: VoiceDeps = { readSecret: secretFromEnvironment };

export function baseOf(deps: VoiceDeps): string {
  const base = deps.publicBase ?? process.env["PUBLIC_URL"];
  if (!base) {
    throw new ConflictError(
      "PUBLIC_URL is not set, so there is no address to point a number's calls at. Set it to this installation's public address.",
    );
  }
  return base.replace(/\/$/, "");
}

export const voiceWebhookPath = (token: string, step?: string) =>
  `/api/webhooks/voice/${token}${step ? `/${step}` : ""}`;

export function webhooksFor(base: string, token: string): NumberWebhooks {
  return {
    voiceUrl: `${base}${voiceWebhookPath(token)}`,
    statusUrl: `${base}${voiceWebhookPath(token, "status")}`,
    smsUrl: `${base}/api/webhooks/messaging/${token}`,
  };
}

export interface Carrier {
  connectionId: string;
  token: string;
  provider: VoiceProvider;
  /** The connection's own settings: the Account SID, the webhook token, and the browser phone's. */
  settings: Record<string, unknown>;
}

/**
 * The company's carrier account, for calls.
 *
 * The messaging connection, because it is the same Twilio account and the
 * same credential: its settings hold the Account SID, its `credentialRef`
 * names the auth token, and its webhook token is the secret in every URL a
 * number is pointed at.
 */
export async function carrierFor(tx: Database, organizationId: string, deps: VoiceDeps): Promise<Carrier> {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "messaging"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    ));
  if (!row || !voiceCapableProviders().includes(row.provider)) {
    throw new ConflictError(
      "Connect your Twilio account under Settings, Integrations first. Numbers are bought from your own account, "
      + "and calls are routed through the same connection your texts use.",
    );
  }
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const token = typeof settings["webhookToken"] === "string" ? settings["webhookToken"] : "";
  if (token.length < 32) throw new ConflictError("The Twilio connection has no webhook address yet. Reconnect it.");
  const provider = deps.provider
    ?? createVoiceProvider(row.provider, settings, row.credentialRef ? await deps.readSecret(row.credentialRef) : "");
  return { connectionId: row.id, token, provider, settings };
}

