/**
 * THE MCP SERVER, OVER A PIPE
 *
 * The transport a desktop client uses: Claude Desktop, an editor, anything
 * that starts a server as a child process and talks JSON-RPC down stdin and
 * stdout. The HTTP transport is for a hosted deployment; this is the one most
 * people actually meet MCP through, and it was the named gap on the front
 * page.
 *
 *   OPENTRADESOS_TOKEN=tok_... DATABASE_URL=postgres://... \
 *     pnpm --filter @opentradesos/api mcp
 *
 * In a client's configuration that is a command, an args array and an env
 * block, which is the whole of what those clients accept.
 *
 * THE TOKEN IS AN APP TOKEN, the same one the HTTP API takes as a bearer, so
 * this process holds exactly the permissions that token was issued with and
 * revoking it stops this server on the next call. There is no separate
 * credential and no local bypass: a pipe on somebody's laptop is not evidence
 * of who is at the other end of it.
 *
 * NOTHING MAY BE PRINTED. stdout is the protocol, and one stray line makes
 * every message after it unparseable on a stream the client cannot
 * resynchronise. Every diagnostic below goes to stderr, which clients show in
 * their logs and never parse.
 */
import { createClient } from "@opentradesos/db";
import { serveStdio, tokenFromEnvironment } from "../mcp/stdio";
import { authenticate } from "../http/authenticate";

const note = (line: string): void => void process.stderr.write(`[mcp] ${line}\n`);

const url = process.env["DATABASE_URL"];
if (!url) {
  note("Set DATABASE_URL to the database this company runs on.");
  process.exit(1);
}

const token = tokenFromEnvironment();
if (!token) {
  /**
   * REFUSED AT STARTUP RATHER THAN SERVED EMPTY.
   *
   * Without a token every tool list comes back empty and every call is
   * refused, which is correct and looks exactly like a product that does not
   * work. The client shows a connected server with no tools and the person
   * has no way to tell that apart from a bug. Exiting with the reason on
   * stderr puts the sentence where they will read it.
   */
  note(
    "Set OPENTRADESOS_TOKEN to an app token. Issue one under Settings, connected apps. "
    + "If it is set, check it for a stray space or a smart quote: a token copied out of a "
    + "web page often brings one, and it cannot travel in a header.",
  );
  process.exit(1);
}

const db = createClient(url);

/**
 * THERE IS NO COOKIE DOWN A PIPE, so the session resolver returns nothing.
 *
 * `authenticate` takes both because the web route has both: a bearer token
 * from an application, or a cookie from a person signed in on that browser.
 * Here only the first can exist, and saying so explicitly is better than
 * leaving a resolver that might one day read a cookie file off whatever
 * machine this happens to be running on.
 */
const auth = { db, session: async () => null };

/**
 * One identity for the life of the process, checked on every message anyway.
 *
 * The token cannot change while this runs: nothing rewrites a child process's
 * environment. What CAN change is whether it is still valid, so the lookup
 * happens per message rather than once at startup, and a token revoked from
 * the settings screen stops this server on its next call rather than when
 * somebody remembers to restart their client.
 */
const asBearer = (): Request =>
  new Request("stdio://local/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

const server = serveStdio({
  log: note,
  deps: {
    db,
    serverName: "opentradesos",
    /**
     * Listed and enforced from the same token, the same way the HTTP route
     * does it. Listing may be narrower than enforcement and never wider: if
     * these disagreed in the other direction the dispatcher would still
     * refuse, and the person would see a tool that always fails.
     */
    resolveActor: async () => (await authenticate(asBearer(), auth))?.ctx.actor ?? null,
    resolveSession: async () => (await authenticate(asBearer(), auth))?.ctx ?? null,
  },
});

/**
 * A closed pipe means the client is gone.
 *
 * Exiting is the right answer: a stdio server outliving its client is an
 * orphaned process holding a database connection, and on a laptop that people
 * open and close all day they accumulate.
 */
process.stdin.on("end", () => {
  server.close();
  process.exit(0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

note("ready, speaking JSON-RPC on stdin and stdout");
