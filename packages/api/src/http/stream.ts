import { errorResponse } from "./problem";

/**
 * AN ANSWER AS IT IS WRITTEN, OVER THE API
 *
 * A route that declares `streams` can answer as Server-Sent Events as well as
 * JSON. JSON stays the default: a caller gets events only by asking for them
 * with `Accept: text/event-stream`, so every client written before this keeps
 * the answer it always had.
 *
 * Three events, in this order:
 *
 *   writing   `{ "text": ... }`, the answer so far: whole sentences, each held
 *             to the price check before it is sent (core's `showAsWritten`).
 *             Sent each time it grows, the whole of it each time, so a client
 *             that missed one shows the next and is right.
 *   answer    The JSON the route answers without a stream, after every check
 *             the whole answer is held to. It replaces what was shown, and it
 *             may say the answer cannot be shown.
 *   problem   `{ "error", "status" }`, the refusal the route would have sent
 *             as its status and body, when it comes after the stream opened.
 *
 * WHO, BEFORE ANY EVENT. The stream is opened only once there is something to
 * send in it: the first sentence, or the whole answer. A refusal before then
 * (signed out, not allowed, the assistant off, the day's runs used up, a
 * visit not on the person's day) is the same status and body the JSON route
 * answers, because the handler is the same function and nothing has been
 * sent. A refusal after the first sentence can only be a `problem` event, as
 * the status has gone.
 *
 * A dropped connection does not stop the answer: it is written and kept as
 * it would have been, so a retry with the same idempotency key answers from
 * the record where the route keeps one.
 */

/** Whether the caller asked for events. A preference among others still counts. */
export function wantsEventStream(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.split(",").some((part) => part.split(";")[0]!.trim().toLowerCase() === "text/event-stream");
}

/** Handed the answer so far, by a handler that can show one. */
export type Show = (text: string) => void;

/** One event, as the format writes it: every line of the data on a `data:` line of its own. */
export function eventText(event: string, value: unknown): string {
  const data = JSON.stringify(value ?? null).split("\n").map((line) => `data: ${line}`).join("\n");
  return `event: ${event}\n${data}\n\n`;
}

/** How often a quiet stream says it is still open, so a proxy does not close it as idle. */
const KEEP_ALIVE_MS = 15_000;

export async function eventStream(
  run: (show: Show) => Promise<unknown>,
  status: number,
): Promise<Response> {
  const pending: string[] = [];
  let send: ((text: string) => void) | null = null;
  let opened: (() => void) | null = null;
  const firstPiece = new Promise<void>((resolve) => { opened = resolve; });

  const show: Show = (text) => {
    const event = eventText("writing", { text });
    if (send) send(event);
    else pending.push(event);
    opened?.();
  };

  const answering = run(show).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const first = await Promise.race([answering, firstPiece.then(() => null)]);
  /** Refused before anything was shown: the route's own status and body. */
  if (first && !first.ok && pending.length === 0) return errorResponse(first.error);

  const encoder = new TextEncoder();
  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      for (const event of pending.splice(0)) write(event);
      send = write;
      keepAlive = setInterval(() => write(": still writing\n\n"), KEEP_ALIVE_MS);
      void answering.then(async (outcome) => {
        if (outcome.ok) write(eventText("answer", outcome.value));
        else {
          const refusal = errorResponse(outcome.error);
          const said = await refusal.json().catch(() => null) as { error?: unknown } | null;
          write(eventText("problem", {
            error: typeof said?.error === "string" ? said.error : "Internal error",
            status: refusal.status,
          }));
        }
        if (keepAlive) clearInterval(keepAlive);
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* the reader went first */ }
        }
      });
    },
    cancel() {
      /** The caller left. The answer is still written and kept; there is just nobody to send it to. */
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new Response(body, {
    status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      /** A proxy that buffers a response would hold every sentence until the end. */
      "x-accel-buffering": "no",
    },
  });
}
