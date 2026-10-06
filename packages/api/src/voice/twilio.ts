import { timingSafeEqual } from "node:crypto";
import { twilioSignature } from "../comms/twilio";
import {
  registerVoiceProvider,
  type AvailableNumber, type NumberWebhooks, type VoiceProvider, type VoiceResult, type WebhookRequest,
} from "./provider";

/**
 * TWILIO, FOR CALLS
 *
 * The same account the company already texts through, under the same
 * connection: its Account SID in the connection's settings and its auth
 * token in the deployment's secret store under the name the connection
 * holds. Nothing here asks for a second credential, and nothing here stores
 * one.
 *
 * Written against the HTTP API directly, like the messaging adapter, so a
 * self hoster can read every request that leaves their network. The
 * transport is a parameter: tests hand in a fake and no test reaches Twilio.
 */

interface Settings {
  accountSid?: string;
  /** Override for testing. Never set in production. */
  baseUrl?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Errors that a retry may clear: throttling and Twilio's own trouble. */
const retryable = (status: number, code: string) => status === 429 || status >= 500 || code === "20429";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createTwilioVoice(
  settings: Record<string, unknown>,
  authToken: string,
  transport: Fetch = (url, init) => fetch(url, init),
): VoiceProvider {
  const config = settings as Settings;
  const sid = config.accountSid ?? "";
  const base = (config.baseUrl ?? "https://api.twilio.com").replace(/\/$/, "");
  const account = `${base}/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
  const auth = `Basic ${Buffer.from(`${sid}:${authToken}`).toString("base64")}`;

  async function call<T>(
    url: string, init: { method: string; form?: URLSearchParams },
    shape: (payload: Record<string, unknown>) => T,
  ): Promise<VoiceResult<T>> {
    let response: Response;
    try {
      response = await transport(url, {
        method: init.method,
        headers: {
          Authorization: auth,
          ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(init.form ? { body: init.form } : {}),
      });
    } catch (error) {
      return {
        ok: false, code: "network", retryable: true,
        message: `Twilio could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (response.status === 204) return { ok: true, ...shape({}) };
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = String(payload["code"] ?? response.status);
      return {
        ok: false, code, retryable: retryable(response.status, code),
        message: String(payload["message"] ?? response.statusText ?? "Twilio refused the request."),
      };
    }
    return { ok: true, ...shape(payload) };
  }

  const hooks = (form: URLSearchParams, webhooks: NumberWebhooks) => {
    form.set("VoiceUrl", webhooks.voiceUrl);
    form.set("VoiceMethod", "POST");
    form.set("StatusCallback", webhooks.statusUrl);
    form.set("StatusCallbackMethod", "POST");
    form.set("SmsUrl", webhooks.smsUrl);
    form.set("SmsMethod", "POST");
    return form;
  };

  return {
    name: "twilio",

    /**
     * The same signature the messaging webhook checks: HMAC-SHA1 over the
     * public URL with the sorted form fields appended. The URL includes the
     * query string, which is how the step of a call travels, so a forged step
     * fails the signature like a forged body does.
     */
    verify(request: WebhookRequest): boolean {
      const signature = request.headers["x-twilio-signature"];
      if (!signature) return false;
      // fromEntries defines each field rather than assigning it, so a field
      // named `__proto__` is only a field.
      const params: Record<string, string> = Object.fromEntries(new URLSearchParams(request.body));
      return equal(signature, twilioSignature(authToken, request.url, params));
    },

    searchNumbers(query) {
      const params = new URLSearchParams({ VoiceEnabled: "true", PageSize: String(Math.min(query.limit, 20)) });
      if (query.areaCode) params.set("AreaCode", query.areaCode);
      if (query.locality) params.set("InLocality", query.locality);
      if (query.region) params.set("InRegion", query.region);
      return call(`${account}/AvailablePhoneNumbers/US/Local.json?${params}`, { method: "GET" }, (payload) => ({
        numbers: ((payload["available_phone_numbers"] as Record<string, unknown>[] | undefined) ?? [])
          .map((n): AvailableNumber => ({
            e164: String(n["phone_number"] ?? ""),
            friendlyName: String(n["friendly_name"] ?? n["phone_number"] ?? ""),
            locality: typeof n["locality"] === "string" ? n["locality"] : null,
            region: typeof n["region"] === "string" ? n["region"] : null,
          }))
          .filter((n) => n.e164 !== ""),
      }));
    },

    buyNumber(input) {
      const form = hooks(new URLSearchParams({ PhoneNumber: input.e164 }), input.webhooks);
      if (input.label) form.set("FriendlyName", input.label.slice(0, 64));
      return call(`${account}/IncomingPhoneNumbers.json`, { method: "POST", form }, (payload) => ({
        providerNumberId: String(payload["sid"] ?? ""),
        e164: String(payload["phone_number"] ?? input.e164),
      }));
    },

    configureNumber(input) {
      return call(
        `${account}/IncomingPhoneNumbers/${encodeURIComponent(input.providerNumberId)}.json`,
        { method: "POST", form: hooks(new URLSearchParams(), input.webhooks) },
        () => ({}),
      );
    },

    findNumber(e164) {
      const params = new URLSearchParams({ PhoneNumber: e164 });
      return call(`${account}/IncomingPhoneNumbers.json?${params}`, { method: "GET" }, (payload) => {
        const rows = (payload["incoming_phone_numbers"] as Record<string, unknown>[] | undefined) ?? [];
        const row = rows.find((r) => r["phone_number"] === e164);
        if (!row || typeof row["sid"] !== "string") return { found: false as const };
        const text = (value: unknown) => typeof value === "string" && value !== "" ? value : null;
        return {
          found: true as const,
          providerNumberId: row["sid"],
          voiceUrl: text(row["voice_url"]),
          statusUrl: text(row["status_callback"]),
        };
      });
    },

    pointCalls(input) {
      const form = new URLSearchParams({
        VoiceUrl: input.voiceUrl, VoiceMethod: "POST",
        StatusCallback: input.statusUrl, StatusCallbackMethod: "POST",
      });
      return call(
        `${account}/IncomingPhoneNumbers/${encodeURIComponent(input.providerNumberId)}.json`,
        { method: "POST", form },
        () => ({}),
      );
    },

    releaseNumber(providerNumberId) {
      return call(
        `${account}/IncomingPhoneNumbers/${encodeURIComponent(providerNumberId)}.json`,
        { method: "DELETE" },
        () => ({}),
      );
    },

    /**
     * The audio, as MP3. Only ever a URL on Twilio's own API host: the URL
     * arrives in a webhook, and a signed webhook is still a body somebody
     * wrote, so an address anywhere else is refused rather than fetched with
     * the account's credentials attached.
     */
    async fetchRecording(recordingUrl) {
      if (!recordingUrl.startsWith(`${base}/`)) {
        return { ok: false, code: "foreign_url", retryable: false, message: "That recording is not on the carrier's API." };
      }
      try {
        const response = await transport(`${recordingUrl.replace(/\.(mp3|wav|json)$/, "")}.mp3`, {
          method: "GET", headers: { Authorization: auth },
        });
        if (!response.ok) {
          return {
            ok: false, code: String(response.status), retryable: retryable(response.status, ""),
            message: `Twilio answered ${response.status} for the recording.`,
          };
        }
        return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) };
      } catch (error) {
        return {
          ok: false, code: "network", retryable: true,
          message: `Twilio could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    placeCall(input) {
      const form = new URLSearchParams({
        To: input.to, From: input.from, Url: input.url, Method: "POST",
        Timeout: String(Math.max(5, Math.min(60, Math.round(input.timeoutSeconds)))),
      });
      return call(`${account}/Calls.json`, { method: "POST", form }, (payload) => ({
        callSid: String(payload["sid"] ?? ""),
      }));
    },

    startRecording(input) {
      const form = new URLSearchParams({
        RecordingStatusCallback: input.recordingCallback,
        RecordingStatusCallbackMethod: "POST",
        RecordingStatusCallbackEvent: "completed",
        RecordingChannels: "dual",
      });
      return call(
        `${account}/Calls/${encodeURIComponent(input.callSid)}/Recordings.json`,
        { method: "POST", form },
        () => ({}),
      );
    },

    saveApplication(input) {
      const form = new URLSearchParams({
        FriendlyName: input.label.slice(0, 64),
        VoiceUrl: input.voiceUrl, VoiceMethod: "POST",
        StatusCallback: input.statusUrl, StatusCallbackMethod: "POST",
      });
      const target = input.applicationSid
        ? `${account}/Applications/${encodeURIComponent(input.applicationSid)}.json`
        : `${account}/Applications.json`;
      return call(target, { method: "POST", form }, (payload) => ({
        applicationSid: String(payload["sid"] ?? input.applicationSid ?? ""),
      }));
    },

    deleteRecording(recordingId) {
      return call(`${account}/Recordings/${encodeURIComponent(recordingId)}.json`, { method: "DELETE" }, () => ({}));
    },
  };
}

registerVoiceProvider("twilio", createTwilioVoice);
