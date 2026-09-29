import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { Actor } from "@opentradesos/core";
import { serveStdio, tokenFromEnvironment } from "../src/mcp/stdio";
import { PROTOCOL_VERSION } from "../src/mcp/server";

/**
 * MCP OVER STDIO
 *
 * The transport most people actually meet MCP through: a desktop client
 * starts the server as a child process and talks to it down a pipe. It was
 * the named gap on the front page.
 *
 * No database here. Every property below is about the FRAMING, which is
 * where a stdio server goes wrong, and the rules of the protocol itself are
 * tested against `handleMcp` next door. That split is the point of this
 * transport wrapping that handler rather than reimplementing it: there is
 * one set of rules about what an unauthenticated list contains and what a
 * refusal looks like, and a second handler written for pipes would be a
 * second set that disagrees within a month.
 */

const owner: Actor = { userId: "u", organizationId: "o", roles: ["owner"] };

/** A harness that speaks to the transport the way a client does. */
function harness(actor: Actor | null = owner) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logged: string[] = [];

  const server = serveStdio({
    input,
    output,
    log: (line) => logged.push(line),
    deps: {
      db: null as never,
      resolveActor: async () => actor,
      resolveSession: async () => (actor ? { actor, db: null as never } : null),
    },
  });

  const frames: unknown[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") frames.push(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  });

  /** Let the queued work drain. The transport answers one message at a time. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  return { input, output, frames, logged, server, settle, raw: () => buffer };
}

describe("the framing", () => {
  it("answers a request with one line of JSON", async () => {
    const h = harness();
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    await h.settle();

    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({
      jsonrpc: "2.0", id: 1,
      result: { protocolVersion: PROTOCOL_VERSION },
    });
    h.server.close();
  });

  it("never pretty prints, because a newline splits the frame", async () => {
    const h = harness();
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await h.settle();

    /**
     * A response containing a newline would arrive as two frames, the second
     * of which is not valid JSON, and the client has no way to resynchronise
     * a stream it cannot parse.
     */
    const written = JSON.stringify(h.frames[0]);
    expect(written).not.toContain("\n");
    h.server.close();
  });

  it("keeps a message that arrives split across chunks", async () => {
    const h = harness();
    const message = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize" });

    /**
     * A pipe delivers whatever happened to be in the buffer, which splits a
     * message anywhere: mid-token, mid-string, mid-escape. Parsing each chunk
     * as it arrives produces a parse error on every message big enough to be
     * split, which is every message with a real payload in it.
     */
    h.input.write(message.slice(0, 11));
    await h.settle();
    expect(h.frames).toHaveLength(0);

    h.input.write(`${message.slice(11)}\n`);
    await h.settle();
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ id: 7 });
    h.server.close();
  });

  it("reads two messages out of one chunk", async () => {
    const h = harness();
    h.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    await h.settle();

    expect(h.frames.map((f) => (f as { id: number }).id)).toEqual([1, 2]);
    h.server.close();
  });

  it("answers in the order the messages arrived", async () => {
    const h = harness();
    for (const id of [1, 2, 3, 4]) {
      h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`);
    }
    await h.settle();

    /**
     * Sequential is the right default for a transport whose whole premise is
     * one person at one keyboard. Handling concurrently would mean two tool
     * calls writing to the same database from one connection with no
     * ordering between them, and a tool call here books a job or takes a
     * payment.
     */
    expect(h.frames.map((f) => (f as { id: number }).id)).toEqual([1, 2, 3, 4]);
    h.server.close();
  });

  it("does not lose a last line written without a newline", async () => {
    const h = harness();
    h.input.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize" }));
    h.input.end();
    await h.settle();

    /**
     * A client that writes its final frame and closes the pipe is not
     * malformed, and dropping that frame loses whatever it was.
     */
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ id: 9 });
    h.server.close();
  });

  it("ignores a blank line rather than answering it", async () => {
    const h = harness();
    h.input.write("\n   \n");
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    await h.settle();

    expect(h.frames).toHaveLength(1);
    h.server.close();
  });
});

describe("what must never reach stdout", () => {
  it("writes nothing back for a notification", async () => {
    const h = harness();
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await h.settle();

    /**
     * `notifications/initialized` arrives from every client immediately after
     * the handshake. Answering it with a JSON-RPC response is a protocol
     * violation and the clients that check it disconnect.
     */
    expect(h.frames).toHaveLength(0);
    expect(h.raw()).toBe("");

    /**
     * And QUIETLY. Writing nothing is not enough on its own: without the
     * explicit 202 check the empty body reaches `JSON.parse`, throws, and is
     * caught by the guard meant for a corrupt frame. Nothing reaches stdout
     * either way, so the frame assertions above pass in both worlds, and the
     * only difference is that every notification from every client logs an
     * error that is not one. A log full of false alarms is a log nobody
     * reads when a real one arrives.
     */
    expect(h.logged).toEqual([]);
    h.server.close();
  });

  it("puts diagnostics on the log, never on the stream", async () => {
    const h = harness();
    h.input.write("this is not json\n");
    await h.settle();

    /**
     * STDOUT IS THE PROTOCOL. One stray line and every message after it is
     * unparseable on a stream the client cannot resynchronise. A parse
     * failure is answered as JSON-RPC, which is a frame, and anything else
     * the server wants to say goes to the log.
     */
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ error: { code: -32700 } });
    h.server.close();
  });

  it("answers rather than dying when the handler throws", async () => {
    const h = harness();
    // A resolver that throws is the shape of any failure inside a call.
    const input = new PassThrough();
    const output = new PassThrough();
    const logged: string[] = [];
    const frames: unknown[] = [];
    let buffer = "";
    output.on("data", (c: Buffer) => {
      buffer += c.toString("utf8");
      let n = buffer.indexOf("\n");
      while (n !== -1) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        if (line.trim()) frames.push(JSON.parse(line));
        n = buffer.indexOf("\n");
      }
    });

    const server = serveStdio({
      input, output, log: (l) => logged.push(l),
      deps: {
        db: null as never,
        resolveActor: async () => { throw new Error("the database is down"); },
        resolveSession: async () => null,
      },
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    await new Promise((r) => setTimeout(r, 20));

    /**
     * Over HTTP an unhandled exception becomes a 500 and the client sees a
     * failed request. Down a pipe there is no status line: a server that dies
     * leaves the client waiting forever on a request it will never be
     * answered, and the person sees their assistant hang rather than say
     * anything.
     */
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ error: { code: -32603 } });
    expect(logged.join(" ")).toContain("the database is down");
    server.close();
    h.server.close();
  });
});

describe("who the process is", () => {
  it("shows an unauthenticated connection an empty tool list", async () => {
    const h = harness(null);
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await h.settle();

    /**
     * The rule belongs to `handleMcp` and is asserted here too, because this
     * transport is the one where somebody is most likely to assume a local
     * pipe means a trusted caller. It does not: the token in the client's
     * configuration is the whole of the authority.
     */
    expect(h.frames[0]).toMatchObject({ result: { tools: [] } });
    h.server.close();
  });

  it("reads its credential from the environment, and treats blank as absent", () => {
    expect(tokenFromEnvironment({ OPENTRADESOS_TOKEN: "tok_live" })).toBe("tok_live");
    expect(tokenFromEnvironment({ OPENTRADESOS_TOKEN: "   " })).toBeNull();
    expect(tokenFromEnvironment({})).toBeNull();
  });

  it("refuses a token that cannot travel in a header", () => {
    /**
     * Found by running the thing rather than by reading it. A token pasted
     * out of a web page brings a non-breaking space, a thin space or a smart
     * quote with it more often than anybody expects, and `new Request()`
     * then throws inside the resolver on every message: the client sees "the
     * server failed to handle that request", which is true, useless and
     * points at the wrong thing.
     */
    expect(tokenFromEnvironment({ OPENTRADESOS_TOKEN: "tok_live\u2009x" })).toBeNull();
    expect(tokenFromEnvironment({ OPENTRADESOS_TOKEN: "tok\u00a0live" })).toBeNull();
    expect(tokenFromEnvironment({ OPENTRADESOS_TOKEN: "tok_\u201clive\u201d" })).toBeNull();
  });

  it("stops reading once closed", async () => {
    const h = harness();
    h.server.close();
    h.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    await h.settle();
    expect(h.frames).toHaveLength(0);
  });
});
