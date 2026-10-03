/**
 * PUSH NOTICES TO A TECHNICIAN'S PHONE
 *
 * The product knows about "tell this phone this sentence", and nothing about
 * Expo, Apple or Google. The phone app is an Expo app, so the one
 * adapter that ships is Expo's push service, which forwards to Apple and
 * Google; a test passes a fake and a deployment never fakes one.
 *
 * Two calls, because that is how the service works. Sending answers with a
 * ticket per message saying whether Expo took it. Whether the phone actually
 * got it is a RECEIPT, asked for later by ticket, and the receipt is where
 * "the app is no longer on this phone" turns up. Both answers can say that,
 * and both are acted on, because a token that can never be delivered to and
 * is asked about on every change is noise in the log forever.
 */

export interface PushMessage {
  /** The device's Expo push token. */
  to: string;
  title: string;
  body: string;
  /** What the app needs to open the right screen on a tap. */
  data: Record<string, unknown>;
  /**
   * Inside the company's quiet hours: no sound, and on iOS a passive notice
   * that does not light the screen. See core `pushUrgency`.
   */
  quiet: boolean;
}

export type PushTicket =
  | { ok: true; id: string }
  /**
   * `gone` is the phone no longer having the app, or the token being one
   * Expo never issued. `retryable` is the service having a bad minute.
   * Neither is a reason to stop telling anybody else.
   */
  | { ok: false; error: string; gone: boolean; retryable: boolean };

export type PushReceipt =
  | { ok: true }
  | { ok: false; error: string; gone: boolean };

export interface PushProvider {
  readonly name: string;
  /** One ticket per message, in the same order. Throws only when nothing was answered. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Receipts for tickets it has. A ticket it no longer holds is simply absent. */
  receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
}

/** The Android channels the app creates. A quiet notice goes on the one with no sound. */
export const ANDROID_CHANNEL = { normal: "visits", quiet: "visits-quiet" } as const;

/** Expo takes a hundred messages a request and a thousand receipts. */
export const SEND_BATCH = 100;
export const RECEIPT_BATCH = 1000;

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

interface ExpoError { status: "error"; message?: string; details?: { error?: string } }
interface ExpoOk { status: "ok"; id?: string }

/**
 * Expo's push service.
 *
 * The access token is optional and read from `EXPO_ACCESS_TOKEN`: Expo lets a
 * project require one so a leaked push token cannot be used by somebody else
 * to message the phone, and a company that turns that on sets the variable.
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = "expo";
  private readonly fetcher: typeof fetch;
  private readonly accessToken: string | undefined;

  constructor(options: { fetch?: typeof fetch; accessToken?: string | undefined } = {}) {
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.accessToken = options.accessToken ?? (process.env["EXPO_ACCESS_TOKEN"] || undefined);
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += SEND_BATCH) {
      const batch = messages.slice(i, i + SEND_BATCH);
      const answer = await this.post(SEND_URL, batch.map(expoMessage));
      const data = Array.isArray(answer["data"]) ? answer["data"] as Array<ExpoOk | ExpoError> : null;
      if (!data || data.length !== batch.length) {
        /**
         * The whole request was refused: a malformed body, or a project that
         * requires an access token this deployment does not have. Every
         * message in it gets the same answer, retryable, because nothing was
         * wrong with any one phone.
         */
        const said = describeErrors(answer["errors"]) ?? "The push service did not accept the request.";
        for (const _ of batch) tickets.push({ ok: false, error: said, gone: false, retryable: true });
        continue;
      }
      for (const item of data) tickets.push(ticketOf(item));
    }
    return tickets;
  }

  async receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (let i = 0; i < ticketIds.length; i += RECEIPT_BATCH) {
      const answer = await this.post(RECEIPTS_URL, { ids: ticketIds.slice(i, i + RECEIPT_BATCH) });
      const data = answer["data"];
      if (!data || typeof data !== "object") continue;
      for (const [id, item] of Object.entries(data as Record<string, ExpoOk | ExpoError>)) {
        out[id] = item.status === "ok"
          ? { ok: true }
          : { ok: false, error: errorText(item), gone: item.details?.error === "DeviceNotRegistered" };
      }
    }
    return out;
  }

  private async post(url: string, body: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (this.accessToken) headers["authorization"] = `Bearer ${this.accessToken}`;
    const response = await this.fetcher(url, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`The push service answered ${response.status} with nothing readable.`);
    }
    return parsed as Record<string, unknown>;
  }
}

/** What Expo is sent for one message. */
export function expoMessage(message: PushMessage): Record<string, unknown> {
  return {
    to: message.to,
    title: message.title,
    body: message.body,
    data: message.data,
    /**
     * Quiet is no sound, normal priority, the Android channel with no sound,
     * and iOS's passive level, which puts it in the list without waking the
     * screen. Loud is the default sound and the high priority that gets a
     * notice through a phone's battery saving.
     */
    ...(message.quiet
      ? { priority: "normal", channelId: ANDROID_CHANNEL.quiet, interruptionLevel: "passive" }
      : { sound: "default", priority: "high", channelId: ANDROID_CHANNEL.normal, interruptionLevel: "active" }),
  };
}

function ticketOf(item: ExpoOk | ExpoError): PushTicket {
  if (item.status === "ok" && typeof item.id === "string") return { ok: true, id: item.id };
  const code = item.status === "error" ? item.details?.error : undefined;
  return {
    ok: false,
    error: errorText(item),
    gone: code === "DeviceNotRegistered",
    /** Expo's own rate limit is the one error worth trying again. */
    retryable: code === "MessageRateExceeded",
  };
}

function errorText(item: ExpoOk | ExpoError): string {
  if (item.status === "ok") return "The push service gave no ticket.";
  const code = item.details?.error;
  if (code === "DeviceNotRegistered") return "The app is no longer on this phone, or it has stopped allowing notices.";
  return item.message ?? code ?? "The push service refused it.";
}

function describeErrors(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0] as { message?: unknown; code?: unknown };
  return typeof first.message === "string" ? first.message : typeof first.code === "string" ? first.code : null;
}
