import {
  GeneratedOperations, OPERATIONS, STREAMING_OPERATIONS,
  type CallOptions, type DryRunOperationId, type OperationId, type OperationTypes, type PaginatedOperationId,
  type StreamingOperationId,
} from "./generated";
import { EventStreamParser, type RawEvent } from "./events";

/**
 * THE CLIENT
 *
 * Every operation in the API is a method here, generated from the OpenAPI
 * document, and every one of them goes through `call` below. One request
 * function rather than six hundred is what makes the guarantees uniform: a
 * method cannot forget the token, skip the idempotency key or swallow an
 * error, because no method does any of that itself.
 *
 *   const ots = new OpenTradesOS({ baseUrl: "https://ops.example.com", token: process.env.OTS_TOKEN! });
 *   const { data } = await ots.listCustomers({ q: "smith" });
 *
 * AUTHENTICATION is an app token (`ots_...`), issued to a connected app under
 * Settings, Applications, or collected by an app whose install request was
 * approved. It is sent as a bearer token on every request and never anywhere
 * else: not in a query string, where it would land in access logs.
 *
 * IDEMPOTENCY KEYS ARE AUTOMATIC on every operation that takes one. A key is
 * made per call and reused on this client's own retries, so a request that
 * timed out and was sent again is a no-op on the server rather than a second
 * invoice. Pass `idempotencyKey` yourself when the retry might come from
 * another process, a queue or a restart: only a key you keep can make that
 * safe.
 */

/** Strips trailing slashes with a loop: `/\/+$/` is quadratic on a long run of them. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

export interface ClientOptions {
  /** The instance's address, such as https://ops.example.com. */
  baseUrl: string;
  /** An app token, `ots_...`. */
  token: string;
  /** Where the API is mounted on the instance. `/api` for the reference deployment. */
  apiPath?: string;
  /** A fetch implementation, for runtimes without a global one or for tests. */
  fetch?: typeof fetch;
  /**
   * How many times a request that failed for a reason worth retrying is sent
   * again: no answer at all, 429, or a 5xx. Only operations that are safe to
   * repeat are retried, which is every read and every write that takes an
   * idempotency key. Defaults to 2.
   */
  maxRetries?: number;
  /** Called before each retry, for logging. */
  onRetry?: (attempt: number, reason: string) => void;
}

/** A refusal or a failure, carrying what the server said. */
export class OpenTradesOSError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly operation: string,
    /** Field by field, for a 422: `{ path: "lines.0.quantity", message: "..." }`. */
    readonly issues: Array<{ path: string; message: string }> = [],
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "OpenTradesOSError";
  }
}

/**
 * One event of an answer being written. `writing` is the answer so far, the
 * whole of it each time, so showing the latest one is always right; `answer`
 * is exactly what the operation answers as JSON, replaces what was shown, and
 * is the last event. A refusal after the stream opened is thrown as an
 * `OpenTradesOSError`, as it is for every other call.
 */
export type StreamEvent<K extends StreamingOperationId> =
  | { event: "writing"; data: { text: string }; id: string | null }
  | { event: "answer"; data: OperationTypes[K]["output"]; id: string | null };

export interface EventsOptions extends CallOptions {
  /**
   * How many times in a row a dropped stream is asked for again before
   * giving up. A connection that delivered an event starts the count over.
   * Only operations that take an idempotency key are asked again: the same
   * key makes the second request the same question, not a second one.
   * Defaults to 5.
   */
  maxReconnects?: number;
  /** Where a stream that was read before left off, to resume it after a restart. Needs the same `idempotencyKey`. */
  lastEventId?: string;
  /** Called before each reconnect, for logging. */
  onReconnect?: (attempt: number, reason: string) => void;
}

/** What a dry run answers: what the operation would have returned and what it would have written. */
export interface DryRunReport<T> {
  dryRun: true;
  wouldReturn: T;
  tables: Array<{ table: string; inserted: number; updated: number; deleted: number }>;
  audit: Array<{ action: string; entityType: string; entityId: string | null }>;
  auditTotal: number;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

const newKey = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `sdk_${random}`;
  // A runtime with no Web Crypto is a very old one; this is good enough to be unique per process.
  return `sdk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    fail(signal.reason ?? new Error("Aborted"));
  }, { once: true });
});

export class OpenTradesOS extends GeneratedOperations {
  private readonly base: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly maxRetries: number;
  private readonly onRetry: ClientOptions["onRetry"];

  constructor(options: ClientOptions) {
    super();
    if (!/^ots_[A-Za-z0-9_-]+$/.test(options.token)) {
      /**
       * Refused here rather than sent, because the alternative is a 401 on
       * every call that looks like a revoked token. A token copied out of a
       * web page often brings a space or a smart quote with it.
       */
      throw new Error("That is not an OpenTradesOS app token: it should start with ots_ and contain no spaces.");
    }
    this.base = `${trimTrailingSlashes(options.baseUrl)}${options.apiPath ?? "/api"}`;
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 2;
    this.onRetry = options.onRetry;
  }

  /** Call any operation by its id. Every generated method is this. */
  protected call<K extends OperationId>(
    operation: K, input: OperationTypes[K]["input"], options: CallOptions = {},
  ): Promise<OperationTypes[K]["output"]> {
    return this.send(operation, input as unknown as Record<string, unknown>, options, false) as Promise<OperationTypes[K]["output"]>;
  }

  /**
   * Ask a bulk operation what it WOULD change, without changing anything. It
   * runs on the server and is rolled back; what comes back is what it would
   * have returned, the rows it would have written per table, and the audit
   * lines naming each record.
   */
  dryRun<K extends DryRunOperationId>(
    operation: K, input: OperationTypes[K]["input"], options: CallOptions = {},
  ): Promise<DryRunReport<OperationTypes[K]["output"]>> {
    return this.send(operation, input as unknown as Record<string, unknown>, options, true) as Promise<DryRunReport<OperationTypes[K]["output"]>>;
  }

  /**
   * Every item of a paged list, fetching the next page only as the loop needs
   * it. Follows `nextCursor` until there is none, so a list being written to
   * while you read it neither repeats nor skips a row.
   *
   *   for await (const customer of ots.paginate("listCustomers", { q: "smith" })) { ... }
   */
  async *paginate<K extends PaginatedOperationId>(
    operation: K,
    input: Omit<OperationTypes[K]["input"], "cursor"> = {} as Omit<OperationTypes[K]["input"], "cursor">,
    options: CallOptions = {},
  ): AsyncGenerator<OperationTypes[K]["output"]["data"][number]> {
    let cursor: string | null | undefined;
    do {
      const page = await this.send(
        operation,
        { ...(input as unknown as Record<string, unknown>), ...(cursor ? { cursor } : {}) },
        options,
        false,
      ) as { data: OperationTypes[K]["output"]["data"]; nextCursor: string | null };
      for (const item of page.data) yield item;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * An operation's answer as it is written, one event at a time, for the
   * operations that stream (`StreamingOperationId`).
   *
   *   for await (const e of ots.events("askFieldAssistant", { question })) {
   *     if (e.event === "writing") show(e.data.text);
   *     else done(e.data);
   *   }
   *
   * A dropped connection is asked again after a pause (half a second,
   * doubling, capped at ten, or what the server said with `retry` or
   * `Retry-After`), with the same idempotency key and `Last-Event-ID` set to
   * the last id the server sent, so the server answers the same question
   * rather than a new one. A 429 or a 5xx is asked again the same way. An
   * abort `signal` stops the wait and closes the connection, and so does
   * leaving the loop early. A server that answers JSON instead of events is
   * read as one `answer`.
   */
  async *events<K extends StreamingOperationId>(
    operation: K, input: OperationTypes[K]["input"], options: EventsOptions = {},
  ): AsyncGenerator<StreamEvent<K>, void, undefined> {
    if (!(STREAMING_OPERATIONS as readonly string[]).includes(operation)) {
      throw new Error(`${operation} does not answer as events.`);
    }
    const { spec, url, headers, body } = this.prepare(operation, input as unknown as Record<string, unknown>, options, false);
    headers["accept"] = "text/event-stream";
    const signal = options.signal;
    const maxReconnects = options.maxReconnects ?? 5;
    let lastEventId: string | null = options.lastEventId ?? null;
    let retryBase: number | null = null;
    let failures = 0;

    /** Wait and go round again, or say why not. */
    const again = async (reason: string, retryAfter: string | null): Promise<void> => {
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
      if (!spec.idempotent) {
        throw new OpenTradesOSError(0, `${operation} stopped before it finished (${reason}), and it cannot be asked again safely.`, operation);
      }
      if (failures >= maxReconnects) {
        throw new OpenTradesOSError(0, `${operation} stopped before it finished (${reason}), ${failures} times in a row.`, operation);
      }
      failures += 1;
      options.onReconnect?.(failures, reason);
      await sleep(backoff(failures - 1, retryAfter, retryBase), signal);
    };

    for (;;) {
      if (lastEventId !== null) headers["last-event-id"] = lastEventId;
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: spec.method, headers, ...(body !== undefined ? { body } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        await again((error as Error).message, null);
        continue;
      }

      if (!response.ok) {
        if (RETRYABLE(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          await again(`HTTP ${response.status}`, response.headers.get("retry-after"));
          continue;
        }
        throw await refusal(response, operation);
      }

      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
        /** A server that answered whole, as one written before streams would. */
        const text = await response.text();
        yield { event: "answer", data: (text === "" ? null : JSON.parse(text)) as OperationTypes[K]["output"], id: null };
        return;
      }

      const parser = new EventStreamParser(lastEventId);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let dropped: string | null = null;
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (signal?.aborted) throw signal.reason ?? error;
            dropped = (error as Error).message || "the connection dropped";
            break;
          }
          if (chunk.done) {
            parser.feed(decoder.decode());
            parser.end();
            dropped = "the stream ended before the answer";
            break;
          }
          for (const raw of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
            lastEventId = parser.lastEventId;
            if (parser.retry !== null) retryBase = parser.retry;
            failures = 0;
            const event = read<K>(raw, operation);
            if (!event) continue;
            yield event;
            if (event.event === "answer") return;
          }
          lastEventId = parser.lastEventId;
          if (parser.retry !== null) retryBase = parser.retry;
        }
      } finally {
        /** Left early, aborted, or done: the connection is not held open either way. */
        await reader.cancel().catch(() => undefined);
      }
      await again(dropped ?? "the connection dropped", null);
    }
  }

  private prepare(
    operation: OperationId, input: Record<string, unknown>, options: CallOptions, dryRun: boolean,
  ): { spec: (typeof OPERATIONS)[OperationId]; url: URL; headers: Record<string, string>; body: string | undefined } {
    const spec = OPERATIONS[operation];
    if (!spec) throw new Error(`No operation named ${operation}.`);

    const remaining: Record<string, unknown> = { ...input };
    let path: string = spec.path;
    for (const param of spec.pathParams as readonly string[]) {
      const value = remaining[param];
      if (value === undefined || value === null) {
        throw new OpenTradesOSError(0, `${operation} needs ${param}.`, operation);
      }
      path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
      delete remaining[param];
    }

    const url = new URL(`${this.base}${path}`);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    let body: string | undefined;
    if (spec.method === "GET" || spec.method === "DELETE") {
      for (const [name, value] of Object.entries(remaining)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, String(item));
        else url.searchParams.set(name, String(value));
      }
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(remaining);
    }

    /**
     * Made ONCE per call, before the first attempt, and sent on every retry.
     * A key made per attempt would make each retry a new intent, which is
     * precisely the second charge the key exists to prevent.
     */
    if (spec.idempotent) headers["idempotency-key"] = options.idempotencyKey ?? newKey();
    if (dryRun) {
      if (!spec.dryRun) throw new Error(`${operation} has no dry run.`);
      headers["x-otos-dry-run"] = "true";
    }
    return { spec, url, headers, body };
  }

  private async send(
    operation: OperationId, input: Record<string, unknown>, options: CallOptions, dryRun: boolean,
  ): Promise<unknown> {
    const { spec, url, headers, body } = this.prepare(operation, input, options, dryRun);
    const repeatable = spec.method === "GET" || spec.idempotent || dryRun;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: spec.method, headers, ...(body !== undefined ? { body } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted || !repeatable || attempt >= this.maxRetries) throw error;
        this.onRetry?.(attempt + 1, (error as Error).message);
        await sleep(backoff(attempt, null), options.signal);
        continue;
      }

      if (response.ok) {
        const text = await response.text();
        return text === "" ? null : JSON.parse(text);
      }

      if (repeatable && RETRYABLE(response.status) && attempt < this.maxRetries) {
        this.onRetry?.(attempt + 1, `HTTP ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
        await sleep(backoff(attempt, response.headers.get("retry-after")), options.signal);
        continue;
      }

      throw await refusal(response, operation);
    }
  }
}

/** A refusal, in the server's own words. */
async function refusal(response: Response, operation: string): Promise<OpenTradesOSError> {
  let parsed: unknown = null;
  const text = await response.text();
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const problem = (parsed ?? {}) as { error?: unknown; issues?: Array<{ path: string; message: string }> };
  return new OpenTradesOSError(
    response.status,
    typeof problem.error === "string" ? problem.error : `HTTP ${response.status}`,
    operation,
    Array.isArray(problem.issues) ? problem.issues : [],
    parsed,
  );
}

/**
 * One raw event as the caller sees it. A `problem` is thrown, as a refusal is
 * from every other call; an event this version does not know is passed
 * over, so a server that adds one does not break a client already running.
 */
function read<K extends StreamingOperationId>(raw: RawEvent, operation: string): StreamEvent<K> | null {
  if (raw.event !== "writing" && raw.event !== "answer" && raw.event !== "problem") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.data);
  } catch {
    throw new OpenTradesOSError(0, `${operation} sent a ${raw.event} event that is not JSON.`, operation, [], raw.data);
  }
  if (raw.event === "problem") {
    const problem = (data ?? {}) as { error?: unknown; status?: unknown };
    throw new OpenTradesOSError(
      typeof problem.status === "number" ? problem.status : 500,
      typeof problem.error === "string" ? problem.error : "The answer stopped with an error.",
      operation, [], data,
    );
  }
  if (raw.event === "writing") return { event: "writing", data: data as { text: string }, id: raw.id };
  return { event: "answer", data: data as OperationTypes[K]["output"], id: raw.id };
}

/**
 * Half a second, doubling, capped at ten, or what the server asked for when
 * it said: `Retry-After` in seconds, or an event stream's `retry` in
 * milliseconds as the starting delay.
 */
function backoff(attempt: number, retryAfter: string | null, base: number | null = null): number {
  const asked = retryAfter !== null ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(asked) && asked >= 0) return Math.min(asked * 1000, 60_000);
  return Math.min((base ?? 500) * 2 ** attempt, Math.max(10_000, base ?? 0));
}
