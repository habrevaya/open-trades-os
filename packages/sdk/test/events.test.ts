import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eventText } from "@opentradesos/api/http";
import { EventStreamParser, OpenTradesOS, OpenTradesOSError, type StreamEvent } from "../src/index";

/**
 * READING AN ANSWER AS IT IS WRITTEN, AGAINST A FAKE SERVER
 *
 * A server on a real port that does what an instance does and what a bad
 * network does to it: sends events, drops the connection halfway, answers
 * 503, refuses, or answers JSON. The events it writes come from the API's
 * own `eventText`, so the format read here is the format the server sends.
 */
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
interface Seen { headers: IncomingMessage["headers"]; body: string; closed: Promise<void> }

let server: Server;
let origin = "";
let handlers: Handler[] = [];
let seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
      seen.push({ headers: req.headers, body, closed });
      const handler = handlers.shift();
      if (!handler) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "no handler", status: 500 }));
        return;
      }
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handlers = [];
  seen = [];
});

const client = () => new OpenTradesOS({ baseUrl: origin, token: "ots_test_token" });
const SSE = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };
const withId = (id: string, text: string) => `id: ${id}\n${text}`;
const answer = { answered: true, text: "Shut off the gas first. Then drain it.", sources: [] };

async function all<K extends "askFieldAssistant" | "sayInChat">(
  iterator: AsyncGenerator<StreamEvent<K>>,
): Promise<StreamEvent<K>[]> {
  const out: StreamEvent<K>[] = [];
  for await (const event of iterator) out.push(event);
  return out;
}

describe("the event stream format", () => {
  it("reads events split anywhere, with CRLF, CR, comments, several data lines and a byte order mark", () => {
    const parser = new EventStreamParser();
    expect(parser.feed("﻿: still writing\r\n\r\nevent: writ")).toEqual([]);
    expect(parser.feed('ing\r\ndata: {"text":\r')).toEqual([]);
    expect(parser.feed('\ndata: "One."}\r\rid: 7\nevent: answer\ndata: {}\n\n')).toEqual([
      { event: "writing", data: '{"text":\n"One."}', id: null },
      { event: "answer", data: "{}", id: "7" },
    ]);
    expect(parser.lastEventId).toBe("7");
  });

  it("keeps the last id across events, takes the retry hint, sends nothing for an event with no data, and drops a half event", () => {
    const parser = new EventStreamParser("3");
    expect(parser.feed("retry: 250\n\nretry: soon\n\nid: 4\n\n")).toEqual([]);
    expect(parser.retry).toBe(250);
    expect(parser.lastEventId).toBe("4");
    expect(parser.feed("data: x\n\n")).toEqual([{ event: "message", data: "x", id: "4" }]);
    expect(parser.feed("event: answer\ndata: {}")).toEqual([]);
    parser.end();
    expect(parser.feed("\n")).toEqual([]);
  });
});

describe("events()", () => {
  it("yields each sentence as it comes and then the answer, asking with the token, the key and Accept", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write(eventText("writing", { text: "Shut off the gas first." }));
      setTimeout(() => {
        res.write(": still writing\n\n");
        res.write(eventText("writing", { text: "Shut off the gas first. Then drain it." }));
        res.end(eventText("answer", answer));
      }, 10);
    });
    const events = await all(client().events("askFieldAssistant", { question: "How do we flush it?" }));
    expect(events).toEqual([
      { event: "writing", data: { text: "Shut off the gas first." }, id: null },
      { event: "writing", data: { text: "Shut off the gas first. Then drain it." }, id: null },
      { event: "answer", data: answer, id: null },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["accept"]).toBe("text/event-stream");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer ots_test_token");
    expect(seen[0]!.headers["idempotency-key"]).toMatch(/^sdk_/);
    expect(seen[0]!.headers["last-event-id"]).toBeUndefined();
    expect(JSON.parse(seen[0]!.body)).toEqual({ question: "How do we flush it?" });
  });

  it("asks again after a dropped connection with the same key and the last id, pausing as the server asked", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write("retry: 20\n\n");
      res.write(withId("1", eventText("writing", { text: "Shut off the gas first." })));
      setTimeout(() => res.socket?.destroy(), 10);
    });
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.end(withId("2", eventText("answer", answer)));
    });
    const reconnects: Array<[number, string]> = [];
    const started = Date.now();
    const events = await all(client().events("askFieldAssistant", { question: "How do we flush it?" }, {
      onReconnect: (attempt, reason) => reconnects.push([attempt, reason]),
    }));
    expect(events.map((e) => [e.event, e.id])).toEqual([["writing", "1"], ["answer", "2"]]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.headers["idempotency-key"]).toBe(seen[0]!.headers["idempotency-key"]);
    expect(seen[1]!.headers["last-event-id"]).toBe("1");
    expect(seen[1]!.body).toBe(seen[0]!.body);
    expect(reconnects.map(([n]) => n)).toEqual([1]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("resumes from an id kept from an earlier run, and asks again when the stream ends without an answer", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write("retry: 1\n\n");
      res.end(withId("8", eventText("writing", { text: "Partly." })));
    });
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.end(eventText("answer", answer));
    });
    const events = await all(client().events("askFieldAssistant", { question: "Q" }, {
      idempotencyKey: "kept-key", lastEventId: "5",
    }));
    expect(events.map((e) => e.event)).toEqual(["writing", "answer"]);
    expect(seen[0]!.headers["idempotency-key"]).toBe("kept-key");
    expect(seen[0]!.headers["last-event-id"]).toBe("5");
    expect(seen[1]!.headers["last-event-id"]).toBe("8");
    // The last id outlives the event it came with: the answer carries it too.
    expect(events[1]!.id).toBe("8");
  });

  it("waits out a 503 for as long as Retry-After says, then reads the stream", async () => {
    handlers.push((_req, res) => {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: "Busy", status: 503 }));
    });
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.end(eventText("answer", answer));
    });
    const reasons: string[] = [];
    const events = await all(client().events("askFieldAssistant", { question: "Q" }, { onReconnect: (_n, r) => reasons.push(r) }));
    expect(events).toEqual([{ event: "answer", data: answer, id: null }]);
    expect(reasons).toEqual(["HTTP 503"]);
  });

  it("gives up after so many drops in a row", async () => {
    for (let i = 0; i < 3; i++) {
      handlers.push((_req, res) => {
        res.writeHead(201, SSE);
        res.write("retry: 1\n\n");
        res.socket?.destroy();
      });
    }
    const error = await all(client().events("askFieldAssistant", { question: "Q" }, { maxReconnects: 2 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenTradesOSError);
    expect((error as Error).message).toMatch(/2 times in a row/);
    expect(seen).toHaveLength(3);
  });

  it("throws a refusal before the first event in the server's words, without asking again", async () => {
    handlers.push((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The field assistant is off.", status: 409 }));
    });
    const error = await all(client().events("askFieldAssistant", { question: "Q" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenTradesOSError);
    expect(error).toMatchObject({ status: 409, message: "The field assistant is off.", operation: "askFieldAssistant" });
    expect(seen).toHaveLength(1);
  });

  it("throws a problem after the first sentence, having yielded the sentence", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write(eventText("writing", { text: "First." }));
      res.end(eventText("problem", { error: "The model could not be reached.", status: 409 }));
    });
    const got: string[] = [];
    let error: unknown = null;
    try {
      for await (const event of client().events("askFieldAssistant", { question: "Q" })) got.push(event.event);
    } catch (e) {
      error = e;
    }
    expect(got).toEqual(["writing"]);
    expect(error).toMatchObject({ status: 409, message: "The model could not be reached." });
    expect(seen).toHaveLength(1);
  });

  it("reads a server that answers JSON instead of events as one answer", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
    expect(await all(client().events("askFieldAssistant", { question: "Q" }))).toEqual([{ event: "answer", data: answer, id: null }]);
  });

  it("stops at once on the abort signal, mid stream, and closes the connection", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write(eventText("writing", { text: "First." }));
      // Never finishes: only the abort ends this.
    });
    const controller = new AbortController();
    const got: string[] = [];
    const error = await (async () => {
      for await (const event of client().events("askFieldAssistant", { question: "Q" }, { signal: controller.signal })) {
        got.push(event.event);
        controller.abort(new Error("the person left"));
      }
    })().catch((e: unknown) => e);
    expect(got).toEqual(["writing"]);
    expect((error as Error).message).toBe("the person left");
    await seen[0]!.closed;
    expect(seen).toHaveLength(1);
  });

  it("stops waiting to reconnect on the abort signal", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write("retry: 60000\n\n");
      res.write(eventText("writing", { text: "First." }));
      setTimeout(() => res.socket?.destroy(), 10);
    });
    const controller = new AbortController();
    const started = Date.now();
    const error = await all(client().events("askFieldAssistant", { question: "Q" }, {
      signal: controller.signal,
      onReconnect: () => setTimeout(() => controller.abort(new Error("cancelled")), 20),
    })).catch((e: unknown) => e);
    expect((error as Error).message).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
  });

  it("closes the connection when the loop is left early", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write(eventText("writing", { text: "First." }));
    });
    for await (const event of client().events("askFieldAssistant", { question: "Q" })) {
      expect(event.event).toBe("writing");
      break;
    }
    await seen[0]!.closed;
  });

  it("does not ask again for an operation that takes no idempotency key, since that would be a second question", async () => {
    handlers.push((_req, res) => {
      res.writeHead(201, SSE);
      res.write(eventText("writing", { text: "Hello." }));
      setTimeout(() => res.socket?.destroy(), 10);
    });
    const error = await all(client().events("sayInChat", { companyKey: "k", token: "t", text: "Hi" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenTradesOSError);
    expect((error as Error).message).toMatch(/cannot be asked again safely/);
    expect(seen).toHaveLength(1);
  });

  it("refuses an operation that does not stream", async () => {
    const ots = client() as unknown as { events: (op: string, input: object) => AsyncGenerator<unknown> };
    await expect(ots.events("listCustomers", {}).next()).rejects.toThrow(/does not answer as events/);
    expect(seen).toHaveLength(0);
  });
});
