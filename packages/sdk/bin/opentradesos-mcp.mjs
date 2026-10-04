#!/usr/bin/env node
/**
 * OPENTRADESOS OVER MCP, FROM A DESKTOP CLIENT, TO A HOSTED INSTANCE
 *
 * A desktop MCP client (Claude Desktop, an editor) starts a server as a child
 * process and talks JSON-RPC down its stdin and stdout. This is that process,
 * and all it does is carry each message to the instance's `/api/mcp`
 * endpoint with an app token and carry the answer back. Every rule about the
 * protocol (what a tool list holds, what a refusal looks like, which
 * permissions a tool needs) lives on the server, so a bridge on somebody's
 * laptop cannot disagree with it.
 *
 *   OPENTRADESOS_URL=https://ops.example.com OPENTRADESOS_TOKEN=ots_... npx @opentradesos/sdk
 *
 * From a checkout of the repository, before the package is published:
 *
 *   OPENTRADESOS_URL=... OPENTRADESOS_TOKEN=... node packages/sdk/bin/opentradesos-mcp.mjs
 *
 * Plain JavaScript with no dependencies, so it runs under `npx` or `node`
 * with nothing built and nothing installed.
 *
 * STDOUT IS THE PROTOCOL. Nothing else is ever written to it: one stray line
 * and the client cannot parse another message. Diagnostics go to stderr.
 */
import { pathToFileURL } from "node:url";

/**
 * Carry newline delimited JSON-RPC between a pipe and the instance, one
 * message at a time, in order: a tool call books a job or takes a payment,
 * and two of them racing down one connection is not something anybody asked
 * for.
 *
 * @param {{
 *   url: string, token: string,
 *   input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
 *   log?: (line: string) => void, fetch?: typeof fetch,
 * }} options
 * @returns {{ done: Promise<void> }}
 */
export function bridge(options) {
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/mcp`;
  const send = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((line) => process.stderr.write(`[opentradesos-mcp] ${line}\n`));
  const write = (value) => options.output.write(`${JSON.stringify(value)}\n`);

  /** @param {string} line */
  const handle = async (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let id = null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && "id" in parsed) id = parsed.id ?? null;
    } catch {
      // Sent on as it is: the server answers a parse error in the protocol's own words.
    }

    let response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: trimmed,
      });
    } catch (error) {
      log(`could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      if (id !== null) {
        write({ jsonrpc: "2.0", id, error: { code: -32603, message: `Could not reach ${endpoint}. Check OPENTRADESOS_URL and the network.` } });
      }
      return;
    }

    // A notification takes no reply, and the server says so with a 202.
    if (response.status === 202) return;
    const text = await response.text();

    if (response.status === 401) {
      /**
       * A JSON-RPC error rather than silence. The token was refused: revoked,
       * expired, or for a company that is suspended. Saying so beats a client
       * that shows a connected server with no tools.
       */
      log("the instance refused the token. Issue a new one under Settings, Applications.");
      if (id !== null) {
        write({ jsonrpc: "2.0", id, error: { code: -32001, message: "The instance refused this token. It may be revoked or expired." } });
      }
      return;
    }

    try {
      write(JSON.parse(text));
    } catch {
      log(`the instance answered ${response.status} with something that is not JSON`);
      if (id !== null) {
        write({ jsonrpc: "2.0", id, error: { code: -32603, message: `The instance answered ${response.status}.` } });
      }
    }
  };

  let chain = Promise.resolve();
  let buffer = "";
  options.input.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      chain = chain.then(() => handle(line));
      newline = buffer.indexOf("\n");
    }
  });

  const done = new Promise((resolve) => {
    options.input.on("end", () => {
      if (buffer.trim() !== "") {
        const last = buffer;
        buffer = "";
        chain = chain.then(() => handle(last));
      }
      chain.then(() => resolve(undefined));
    });
  });
  return { done };
}

/** The token as a header can carry it, or null with the reason logged. */
export function tokenFrom(env) {
  const token = env.OPENTRADESOS_TOKEN?.trim();
  if (!token) return null;
  return /^ots_[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

/*
  `npx` runs a package's bin through a symlink, so the path in argv may be the
  link rather than this file. Treat any invocation whose argv names a bin
  called opentradesos-mcp as direct too.
*/
if (invokedDirectly || /opentradesos-mcp(\.mjs)?$/.test(process.argv[1] ?? "")) {
  const note = (line) => process.stderr.write(`[opentradesos-mcp] ${line}\n`);
  const url = process.env.OPENTRADESOS_URL?.trim();
  const token = tokenFrom(process.env);
  if (!url) {
    note("Set OPENTRADESOS_URL to your instance's address, such as https://ops.example.com.");
    process.exit(1);
  }
  if (!token) {
    note("Set OPENTRADESOS_TOKEN to an app token (ots_...). Issue one under Settings, Applications. "
      + "If it is set, check it for a stray space or a smart quote copied from a web page.");
    process.exit(1);
  }
  const { done } = bridge({ url, token, input: process.stdin, output: process.stdout, log: note });
  note(`ready, forwarding to ${url.replace(/\/+$/, "")}/api/mcp`);
  done.then(() => process.exit(0));
}
