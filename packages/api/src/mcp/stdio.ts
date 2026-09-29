import { handleMcp, type McpDeps } from "./server";

/**
 * MCP OVER STDIO
 *
 * The HTTP transport is the one a hosted deployment uses. This is the one a
 * desktop client uses: Claude Desktop, an editor, anything that starts a
 * server as a child process and talks to it down a pipe. It is the transport
 * most people actually meet MCP through, and the product advertised it as
 * missing.
 *
 * IT WRAPS `handleMcp` RATHER THAN REIMPLEMENTING IT, and that is the whole
 * design. Every rule about this protocol lives in one place: that an
 * unauthenticated list is empty rather than the full catalogue, that a
 * refusal is a tool result and not a JSON-RPC error, that a batch is refused
 * rather than half handled, that a notification takes no reply. A second
 * handler written for stdio would be a second set of those rules, and the
 * two would disagree within a month. So a line of input becomes a Request,
 * and the Response becomes a line of output.
 *
 * STDOUT IS THE PROTOCOL. Nothing else may be written to it, ever. This is
 * the single most common way a stdio MCP server breaks: one stray
 * `console.log` left in a service, and every client sees a parse error on a
 * stream it cannot resynchronise. Diagnostics go to stderr, which the client
 * shows in its logs and never parses. The guard below is not decoration.
 */

export interface StdioOptions {
  /**
   * Everything `handleMcp` needs, minus the part that cannot exist here.
   *
   * `resolveActor` and `resolveSession` take a Request over HTTP because a
   * cookie or a bearer token arrives on one. Down a pipe there is no request
   * to read an identity off: the process was started by a client on somebody's
   * machine, with whatever credential was in its configuration.
   */
  deps: Omit<McpDeps, "resolveActor" | "resolveSession"> & {
    resolveActor: McpDeps["resolveActor"];
    resolveSession: McpDeps["resolveSession"];
  };
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Where diagnostics go. Never `output`. */
  log?: (line: string) => void;
}

/**
 * The address a synthesised Request carries.
 *
 * There is no URL in a pipe, and `new Request()` requires one. It is never
 * fetched and never parsed by anything downstream: `handleMcp` reads the
 * method and the body. Named `stdio://` rather than `http://localhost` so
 * that anything logging it says what it actually was.
 */
const STDIO_URL = "stdio://local/mcp";

/**
 * ONE MESSAGE AT A TIME, IN ORDER.
 *
 * JSON-RPC allows a client to send a second request before the first is
 * answered, and the ids exist so replies can arrive out of order. Handling
 * them concurrently would be faster and would also mean two tool calls
 * writing to the same database from one connection with no ordering between
 * them, which for a product where a tool call books a job or takes a payment
 * is a race nobody asked for.
 *
 * Sequential is the right default for a transport whose whole premise is one
 * person at one keyboard. If that ever becomes the bottleneck it is a
 * deliberate change with a queue behind it, not an accident.
 */
export function serveStdio(options: StdioOptions): { close: () => void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  let buffer = "";
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const write = (value: unknown): void => {
    /**
     * One line, no pretty printing. A response containing a newline would
     * split into two frames, the second of which is not valid JSON, and the
     * client has no way to recover the stream.
     *
     * `JSON.stringify` escapes newlines inside strings, so a job summary with
     * a line break in it is safe. What is not safe is formatting the envelope
     * itself.
     */
    output.write(`${JSON.stringify(value)}\n`);
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let response: Response;
    try {
      response = await handleMcp(
        new Request(STDIO_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: trimmed,
        }),
        options.deps,
      );
    } catch (error) {
      /**
       * A THROWN ERROR IS ANSWERED, NOT SWALLOWED AND NOT CRASHED ON.
       *
       * Over HTTP an unhandled exception becomes a 500 and the client sees a
       * failed request. Down a pipe there is no status line: a server that
       * dies leaves the client waiting forever on a request it will never
       * get an answer to, and the person sees their assistant hang rather
       * than say anything.
       *
       * The id cannot be recovered reliably from a message that failed to
       * parse, so a null id is used, which JSON-RPC defines for exactly this
       * case.
       */
      log(`mcp: unhandled error: ${error instanceof Error ? error.message : String(error)}`);
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "The server failed to handle that request." },
      });
      return;
    }

    /**
     * 202 with no body is how `handleMcp` answers a notification, and a
     * notification takes no reply. Writing an empty object back is a protocol
     * violation and the clients that check it disconnect.
     */
    if (response.status === 202) return;

    /**
     * An empty body on any other status is NOT silently swallowed.
     *
     * This used to return early on an empty string as well, which meant the
     * 202 check above guarded nothing: both branches caught the same case and
     * removing either one changed no behaviour. A guard that cannot fail is a
     * guard nobody can trust, and it hid the real rule, which is that 202 is
     * the one documented way `handleMcp` says "no reply" and anything else
     * arriving empty is a defect worth seeing in the log.
     */
    const text = await response.text();

    try {
      write(JSON.parse(text));
    } catch {
      /**
       * `handleMcp` always produces JSON, so this is unreachable today. It is
       * here because the failure it guards is unrecoverable at the other end:
       * writing a non JSON line poisons the stream for every message after
       * it, and a client that cannot parse a frame cannot tell which request
       * it belonged to.
       */
      log("mcp: refused to write a non JSON frame to stdout");
    }
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    /**
     * Newline delimited, and a partial line is KEPT rather than parsed.
     *
     * A pipe delivers whatever happened to be in the buffer, which splits a
     * message anywhere: mid-token, mid-string, mid-escape. Parsing each chunk
     * as it arrives produces a parse error on every message large enough to
     * be split, which is every message with a real payload in it.
     */
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      chain = chain.then(() => handleLine(line));
      newline = buffer.indexOf("\n");
    }
  };

  const onEnd = (): void => {
    /**
     * A last line with no trailing newline is still a message. A client that
     * writes its final frame and closes the pipe is not malformed, and
     * dropping that frame loses whatever it was.
     */
    if (buffer.trim() !== "") {
      const last = buffer;
      buffer = "";
      chain = chain.then(() => handleLine(last));
    }
  };

  input.on("data", onData);
  input.on("end", onEnd);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      input.off("data", onData);
      input.off("end", onEnd);
    },
  };
}

/**
 * Read the credential a stdio server runs as.
 *
 * ONE IDENTITY FOR THE LIFE OF THE PROCESS, which is the real difference
 * between this transport and HTTP. Over HTTP every request carries its own
 * cookie and the actor is resolved per call, so revoking access takes effect
 * on the next request. Here the client started a process with a token in its
 * configuration, and that process is that person until it exits.
 *
 * So the token is read ONCE at startup and the resolver returns the same
 * answer every time. Re-reading the environment per message would suggest it
 * can change, which it cannot: nothing rewrites a child process's environment
 * while it runs. Pretending otherwise would be a revocation story that does
 * not work, which is worse than an honest one that says restart the client.
 */
export function tokenFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = env["OPENTRADESOS_TOKEN"]?.trim();
  if (!token) return null;

  /**
   * REJECTED HERE IF IT CANNOT BE A HEADER, because the alternative is
   * unactionable.
   *
   * A token travels as an `authorization` header, and a header value must be
   * bytes. A person copying one out of a web page brings a non-breaking
   * space, a thin space or a smart quote with it more often than anybody
   * expects, and `new Request()` then throws deep inside the resolver on
   * every single message: "Cannot convert argument to a ByteString because
   * the character at index 41 has a value of 8201".
   *
   * That reaches the client as "the server failed to handle that request",
   * which is true, useless, and points at the wrong thing. Caught at startup
   * it is one sentence about a stray character in a pasted value.
   */
  if (!/^[\x21-\x7e]+$/.test(token)) return null;
  return token;
}
