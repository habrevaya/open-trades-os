import { OfflineError, type Transport, type SyncResponse } from "./queue";
import { EventReader, type ServerEvent } from "./events";
import type { OwnContactRecord } from "./own-contact";
import type {
  ArrivalNoticeResult, AssistantAnswer, CodeRequestResult, FieldSnapshot, FinancingLinkResult, OwedUpload,
  PaymentLinkResult, RegisterResult, SignInResult, StoreUploadResult,
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

/** Strips trailing slashes with a loop: `/\/+$/` is quadratic on a long run of them. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

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
  const path = trimTrailingSlashes(parsed.pathname)
    .replace(/\/(api|login|my-day|schedule)(\/.*)?$/, "");
  const url = `${parsed.protocol}//${parsed.host}${path}`;
  return { ok: true, url, insecure: parsed.protocol === "http:" };
}

/**
 * The part of `XMLHttpRequest` an answer read as it arrives needs.
 *
 * Why not `fetch`: React Native's `fetch` hands over a body only once it has
 * all arrived, on both platforms, and reading it in pieces there takes a
 * native module. Its `XMLHttpRequest` does not: `responseText` grows as the
 * body arrives and `onprogress` says so, on Android and iOS alike, with
 * nothing added to the app. Browsers behave the same way.
 */
export interface StreamingXhr {
  readonly readyState: number;
  readonly status: number;
  readonly responseText: string;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  send(body?: string | null): void;
  abort(): void;
  onreadystatechange: (() => void) | null;
  onprogress: (() => void) | null;
  onerror: (() => void) | null;
}

export interface FieldApiOptions {
  /** As returned by `normalizeServerUrl`. */
  serverUrl: string;
  token?: string | undefined;
  fetch?: typeof fetch;
  /**
   * Makes the request an answer is read from as it is written. Defaults to
   * the platform's own `XMLHttpRequest`; where there is none, the answer is
   * asked for whole.
   */
  xhr?: (() => StreamingXhr) | undefined;
  /** A van on a highway. Long enough for one bar, short enough to give up. */
  timeoutMs?: number;
}

type Method = "GET" | "POST";

export class FieldApi {
  private readonly base: string;
  private readonly root: string;
  private readonly token: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly xhr: (() => StreamingXhr) | undefined;
  private readonly timeoutMs: number;

  constructor(options: FieldApiOptions) {
    this.root = trimTrailingSlashes(options.serverUrl);
    this.base = `${this.root}/api`;
    this.token = options.token;
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.xhr = options.xhr ?? (typeof XMLHttpRequest === "function"
      ? () => new XMLHttpRequest() as unknown as StreamingXhr
      : undefined);
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

  /**
   * The lender's application link for the job on a visit, texted to the
   * customer when asked. Online only, for the same reason as the card link.
   */
  financingLink(visitId: string, text: boolean, idempotencyKey: string): Promise<FinancingLinkResult> {
    return this.request(
      "POST", `/v1/visits/${encodeURIComponent(visitId)}/financing-link`, { text }, { idempotencyKey },
    );
  }

  /**
   * A question for the field assistant, answered from the company's own
   * records. Online only: it asks a model. The key makes a retry answer from
   * the record rather than ask, and pay, twice.
   */
  askAssistant(question: string, visitId: string | null, idempotencyKey: string): Promise<AssistantAnswer> {
    return this.request(
      "POST", "/v1/ai/field-assistant", { question, ...(visitId ? { visitId } : {}) }, { idempotencyKey },
    );
  }

  /**
   * The same question, with the answer read as it is written.
   *
   * Asks the same route for Server-Sent Events. `onWriting` is handed the
   * answer so far each time it grows: whole sentences, each naming only
   * prices in the records, which the server checked before sending. The
   * promise is the whole answer after every check, which takes the place of
   * what was shown and can say it cannot be shown. A refusal is the same
   * error the whole answer gives, and a connection that drops before the
   * answer is no signal; the key makes asking again answer from the record
   * once the first answer was kept.
   *
   * A server that answers whole (one from before this, or a proxy that
   * stripped the header) is read whole, and a platform with no
   * `XMLHttpRequest` asks for the answer whole.
   */
  askAssistantAsItWrites(
    question: string, visitId: string | null, idempotencyKey: string, onWriting: (text: string) => void,
  ): Promise<AssistantAnswer> {
    const make = this.xhr;
    if (!make) return this.askAssistant(question, visitId, idempotencyKey);
    const x = make();
    const reader = new EventReader();
    let seen = 0;
    let streaming: boolean | null = null;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;

    return new Promise<AssistantAnswer>((resolve, reject) => {
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        x.onreadystatechange = null;
        x.onprogress = null;
        x.onerror = null;
        outcome();
      };
      const offline = (message: string) => finish(() => reject(new OfflineError(message)));
      /** Quiet for as long as an ordinary request may take: the server says something every fifteen seconds. */
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          x.abort();
          offline("The server stopped answering.");
        }, this.timeoutMs);
      };
      const handle = (event: ServerEvent) => {
        let data: unknown = null;
        try { data = JSON.parse(event.data); } catch { return; }
        const value = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
        if (event.event === "writing" && typeof value["text"] === "string") onWriting(value["text"]);
        else if (event.event === "answer") finish(() => resolve(value as unknown as AssistantAnswer));
        else if (event.event === "problem") {
          const status = typeof value["status"] === "number" ? value["status"] : 500;
          finish(() => reject(this.refusal(status, value, false)));
        }
      };
      const read = () => {
        if (settled || x.readyState < 2) return;
        if (streaming === null) {
          const type = x.getResponseHeader("content-type") ?? "";
          streaming = x.status >= 200 && x.status < 300 && type.includes("text/event-stream");
        }
        if (!streaming) return;
        const text = x.responseText ?? "";
        const fresh = text.slice(seen);
        seen = text.length;
        for (const event of reader.feed(fresh)) handle(event);
      };
      const done = () => {
        read();
        if (settled) return;
        /** No status is no answer: the signal went, or the address does not reach anything. */
        if (x.status === 0) return offline("Could not reach the server.");
        if (streaming) {
          for (const event of reader.end()) handle(event);
          return offline("The answer did not arrive. Ask again when you have a signal.");
        }
        let parsed: unknown = null;
        try { parsed = JSON.parse(x.responseText); } catch { parsed = null; }
        if (x.status >= 200 && x.status < 300 && parsed !== null) {
          return finish(() => resolve(parsed as AssistantAnswer));
        }
        finish(() => reject(this.refusal(x.status, parsed, false)));
      };

      x.onreadystatechange = () => {
        arm();
        if (x.readyState === 4) done();
        else read();
      };
      x.onprogress = () => { arm(); read(); };
      x.onerror = () => offline("Could not reach the server.");
      try {
        x.open("POST", `${this.base}/v1/ai/field-assistant`);
        x.setRequestHeader("accept", "text/event-stream");
        x.setRequestHeader("content-type", "application/json");
        if (this.token) x.setRequestHeader("authorization", `Bearer ${this.token}`);
        x.setRequestHeader("idempotency-key", idempotencyKey);
        arm();
        x.send(JSON.stringify({ question, ...(visitId ? { visitId } : {}) }));
      } catch {
        offline("Could not reach the server.");
      }
    });
  }

  /**
   * The person's own phone number and home address as the office's record
   * of them holds it (`GET /v1/me`, `profile:own`): theirs alone, there is
   * no one to name. Online only.
   */
  async myContact(): Promise<OwnContactRecord> {
    const record = await this.request<{ ownContact: OwnContactRecord }>("GET", "/v1/me");
    return record.ownContact;
  }

  /**
   * Keep the person's own phone number and home address (`POST
   * /v1/me/contact`), the whole of it, an empty box meaning "take it off".
   * Online only, so a refusal in the server's words reaches the person now.
   * The key makes a retry the same save: sending what is already kept
   * changes nothing and is not written down twice.
   */
  saveMyContact(body: Record<string, string | null>, idempotencyKey: string): Promise<OwnContactRecord> {
    return this.request("POST", "/v1/me/contact", body, { idempotencyKey });
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

  /**
   * How to read a stored file (a photograph the customer sent, a PDF): the
   * address and the headers that make the server answer. The same bearer the
   * phone sends everywhere, so the server asks what it asks for any other
   * read: the person may read documents, in their own company. Never the
   * token in the address, because an address is written into logs and
   * caches and a header is not.
   */
  fileRequest(storageKey: string): { url: string; headers: Record<string, string> } {
    const path = storageKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return {
      url: `${this.root}/files/${path}`,
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    };
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
    throw this.refusal(response.status, parsed, options.anonymous === true);
  }

  /** What a status and the server's body mean for the person holding the phone. */
  private refusal(status: number, parsed: unknown, anonymous: boolean): Error {
    const said = typeof parsed === "object" && parsed !== null
      ? (parsed as { error?: unknown }).error
      : undefined;
    const message = typeof said === "string" && said !== "" ? said : null;

    /**
     * A 401 on a request that carried a token is the token ending. On the
     * sign in route itself it is a wrong password, which is an answer.
     */
    if (status === 401 && !anonymous) return new SignedOutError();

    /**
     * A gateway that could not reach the app behind it answered, but not
     * about the work. Treated like no signal, so a server restarting during
     * a deploy does not cost every phone a try.
     */
    if (status === 502 || status === 503 || status === 504) {
      return new OfflineError("The server is not answering right now.");
    }

    if (status === 404 && (message === null || message.startsWith("No route for"))) {
      return new ApiError(
        "That address answered, but not as an OpenTradesOS server. Check the address, or ask whoever runs it whether it is up to date.",
        404,
      );
    }

    return new ApiError(message ?? `The server refused that (${status}).`, status);
  }
}
