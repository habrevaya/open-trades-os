import {
  GeneratedOperations, OPERATIONS,
  type CallOptions, type DryRunOperationId, type OperationId, type OperationTypes, type PaginatedOperationId,
} from "./generated";

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
    this.base = `${options.baseUrl.replace(/\/+$/, "")}${options.apiPath ?? "/api"}`;
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

  private async send(
    operation: OperationId, input: Record<string, unknown>, options: CallOptions, dryRun: boolean,
  ): Promise<unknown> {
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

      let parsed: unknown = null;
      const text = await response.text();
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      const problem = (parsed ?? {}) as { error?: unknown; issues?: Array<{ path: string; message: string }> };
      throw new OpenTradesOSError(
        response.status,
        typeof problem.error === "string" ? problem.error : `HTTP ${response.status}`,
        operation,
        Array.isArray(problem.issues) ? problem.issues : [],
        parsed,
      );
    }
  }
}

/** Half a second, doubling, capped at ten, or what the server asked for when it said. */
function backoff(attempt: number, retryAfter: string | null): number {
  const asked = retryAfter !== null ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(asked) && asked >= 0) return Math.min(asked * 1000, 60_000);
  return Math.min(500 * 2 ** attempt, 10_000);
}
