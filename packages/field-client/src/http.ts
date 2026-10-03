import { OfflineError, type Transport, type SyncResponse } from "./queue";
import type {
  ArrivalNoticeResult, CodeRequestResult, FieldSnapshot, OwedUpload, PaymentLinkResult, RegisterResult,
  SignInResult, StoreUploadResult,
} from "./wire";

/**
 * THE PHONE TALKING TO A SERVER SOMEBODY ELSE RUNS
 *
 * Every request the phone app makes, in one class with `fetch` injected, so
 * the part that decides what a dropped connection, an expired sign in and a
 * refusal each mean can be tested without a phone or a server.
 *
 * Three outcomes, and keeping them apart is the point of this file:
 *
 *   No answer       OfflineError. Nothing was decided, so the queue keeps
 *                   everything and does not count it as a try.
 *   Signed out      SignedOutError. The token was refused. Also nothing
 *                   decided about the work, so also not counted, and the app
 *                   asks the person to sign in again with the work still on
 *                   the phone.
 *   An answer       ApiError, carrying the server's own sentence, which is
 *                   written for the person reading it.
 */

/** The token was refused: expired, signed out elsewhere, or the phone was taken away. */
export class SignedOutError extends OfflineError {
  readonly signedOut = true as const;
  constructor(message = "Your sign in has ended. Sign in again to send what is waiting on this phone.") {
    super(message);
    this.name = "SignedOutError";
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * What a person typed into "server address", made into something to call.
 *
 * Forgiving about what people actually type: no scheme, a trailing slash, the
 * address of the sign in page they had open in a browser. Strict about the
 * scheme, because a phone sending a password somewhere it was not meant to
 * is the failure here, and it says when the address is not encrypted rather
 * than refusing it, because a company testing on its own network has a
 * genuine reason to.
 */
export function normalizeServerUrl(input: string):
  | { ok: true; url: string; insecure: boolean }
  | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "Enter the address of your company's server." };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "That does not look like a web address." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "The address has to start with https://" };
  }
  if (!parsed.hostname) return { ok: false, error: "That does not look like a web address." };

  /**
   * Pages a person might have copied the address from. The API lives at
   * `/api` under wherever the app is served, so anything after the app's own
   * root is dropped.
   */
  const path = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/(api|login|my-day|schedule)(\/.*)?$/, "");
  const url = `${parsed.protocol}//${parsed.host}${path}`;
  return { ok: true, url, insecure: parsed.protocol === "http:" };
}

export interface FieldApiOptions {
  /** As returned by `normalizeServerUrl`. */
  serverUrl: string;
  token?: string | undefined;
  fetch?: typeof fetch;
  /** A van on a highway. Long enough for one bar, short enough to give up. */
  timeoutMs?: number;
}

type Method = "GET" | "POST";

export class FieldApi {
  private readonly base: string;
  private readonly token: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: FieldApiOptions) {
    this.base = `${options.serverUrl.replace(/\/+$/, "")}/api`;
    this.token = options.token;
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  signIn(input: { email: string; password: string }): Promise<SignInResult> {
    return this.request("POST", "/v1/field/sign-in", input, { anonymous: true });
  }

  /**
   * Ask for a one time code by text or email. The answer is the same whether
   * or not the address belongs to anybody, so it is shown as it comes.
   */
  requestCode(input: { email: string; channel: "sms" | "email" }): Promise<CodeRequestResult> {
    return this.request("POST", "/v1/field/sign-in/code", input, { anonymous: true });
  }

  /** The code in, the same device token a password gets. */
  signInWithCode(input: { email: string; code: string }): Promise<SignInResult> {
    return this.request("POST", "/v1/field/sign-in/verify", input, { anonymous: true });
  }

  /**
   * Register this phone, or register it again with something new, which is
   * how a push token reaches the server: the same call, keyed on the same
   * installation, with the token added.
   */
  register(input: {
    installationId: string;
    label?: string | undefined;
    platform?: "ios" | "android" | undefined;
    appVersion?: string | undefined;
    osVersion?: string | undefined;
    pushToken?: string | undefined;
  }): Promise<RegisterResult> {
    return this.request("POST", "/v1/field/devices", input);
  }

  /**
   * The card payment link for the job on a visit, texted to the customer
   * when asked. Online only, like the text that says you are on your way:
   * a link is worth something with the customer stood there, not an hour
   * later from a queue.
   */
  paymentLink(visitId: string, text: boolean, idempotencyKey: string): Promise<PaymentLinkResult> {
    return this.request(
      "POST", `/v1/visits/${encodeURIComponent(visitId)}/payment-link`, { text }, { idempotencyKey },
    );
  }

  signOut(deviceId: string): Promise<{ ok: true }> {
    return this.request("POST", `/v1/field/devices/${encodeURIComponent(deviceId)}/sign-out`, {});
  }

  snapshot(input: { deviceId: string; from: string; days: number; sinceRevision?: number | undefined }):
    Promise<FieldSnapshot> {
    const query = new URLSearchParams({
      deviceId: input.deviceId, from: input.from, days: String(input.days),
      ...(input.sinceRevision !== undefined ? { sinceRevision: String(input.sinceRevision) } : {}),
    });
    return this.request("GET", `/v1/field/snapshot?${query.toString()}`);
  }

  sync(input: Parameters<Transport["send"]>[0]): Promise<SyncResponse> {
    return this.request("POST", "/v1/field/sync", input);
  }

  async owedUploads(deviceId: string): Promise<OwedUpload[]> {
    const result = await this.request<{ uploads: OwedUpload[] }>(
      "GET", `/v1/field/uploads?deviceId=${encodeURIComponent(deviceId)}`,
    );
    return result.uploads;
  }

  /**
   * The bytes, base64, the way the server takes them from every client.
   * Given four times the ordinary timeout, because a photograph over one bar
   * genuinely takes that long and abandoning it at thirty seconds would mean
   * it never arrives.
   */
  storeUpload(clientId: string, base64: string, caption?: string | undefined): Promise<StoreUploadResult> {
    return this.request(
      "POST", `/v1/field/uploads/${encodeURIComponent(clientId)}`,
      { bytes: base64, ...(caption ? { caption } : {}) },
      { timeoutMs: this.timeoutMs * 4 },
    );
  }

  failUpload(clientId: string, error: string): Promise<unknown> {
    return this.request("POST", `/v1/field/uploads/${encodeURIComponent(clientId)}/failed`, {
      error: error.slice(0, 500),
    });
  }

  onMyWay(visitId: string, etaMinutes: number, idempotencyKey: string): Promise<ArrivalNoticeResult> {
    return this.request(
      "POST", `/v1/visits/${encodeURIComponent(visitId)}/on-my-way`,
      { channel: "sms", etaMinutes, includeTracking: true },
      { idempotencyKey },
    );
  }

  /** The queue's transport. */
  transport(): Transport {
    return { send: (input) => this.sync(input) };
  }

  private async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    options: { anonymous?: boolean; timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token && !options.anonymous) headers["authorization"] = `Bearer ${this.token}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch {
      // fetch rejects for no network, a refused connection, a bad
      // certificate and the timeout above, and none of them is an answer.
      throw new OfflineError("Could not reach the server.");
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (response.ok) return parsed as T;

    const said = typeof parsed === "object" && parsed !== null
      ? (parsed as { error?: unknown }).error
      : undefined;
    const message = typeof said === "string" && said !== "" ? said : null;

    /**
     * A 401 on a request that carried a token is the token ending. On the
     * sign in route itself it is a wrong password, which is an answer.
     */
    if (response.status === 401 && !options.anonymous) throw new SignedOutError();

    /**
     * A gateway that could not reach the app behind it answered, but not
     * about the work. Treated like no signal, so a server restarting during
     * a deploy does not cost every phone a try.
     */
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new OfflineError("The server is not answering right now.");
    }

    if (response.status === 404 && (message === null || message.startsWith("No route for"))) {
      throw new ApiError(
        "That address answered, but not as an OpenTradesOS server. Check the address, or ask whoever runs it whether it is up to date.",
        404,
      );
    }

    throw new ApiError(message ?? `The server refused that (${response.status}).`, response.status);
  }
}
