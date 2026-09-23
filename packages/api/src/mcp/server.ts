import type { Actor } from "@opentradesos/core";
import { dispatch, type DispatchDeps } from "../http/dispatch";
import { allTools, toolsFor, IDEMPOTENCY_FIELD, type McpTool } from "./tools";

/**
 * THE MCP SERVER
 *
 * The pitch for this product is that a company owns its own operations and
 * can drive them however it likes, through APIs and an MCP server that are as
 * easy to reach as the screens. That is a claim about this file. An MCP
 * server that exposes a curated handful of endpoints is a demo; one that
 * exposes the product is the thing that was promised.
 *
 * So every tool comes from the contract registry, and every call goes through
 * the same `dispatch` an HTTP client reaches. Nothing here touches a service
 * or a database directly. Concretely, that means a permission is checked in
 * exactly one place, and an agent cannot reach anything a person with the
 * same credential could not.
 *
 * Written against the protocol rather than a client library, for the same
 * reason the HTTP layer takes a Request and returns a Response: this is meant
 * to be self hosted by people who did not choose its dependencies, and the
 * JSON-RPC envelope below is smaller than the package that would hide it.
 */

/** The revision of MCP this server speaks. */
export const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC's own error codes. They describe a broken envelope, never a
 * refused action: see `toolError` for why that distinction is the important
 * one here.
 */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface McpDeps extends DispatchDeps {
  /**
   * Who is connected. Resolved once per request by the host, the same way the
   * HTTP layer resolves a session, so this file never learns what a cookie or
   * a bearer token is.
   */
  resolveActor: (request: Request) => Promise<Actor | null>;
  /** What the product calls itself in the client's server list. */
  serverName?: string;
  version?: string;
}

const rpc = (id: string | number | null | undefined, result: unknown): Response =>
  json({ jsonrpc: "2.0", id: id ?? null, result });

const rpcError = (
  id: string | number | null | undefined,
  code: number,
  message: string,
): Response => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * A REFUSAL IS A RESULT, NOT A TRANSPORT ERROR.
 *
 * MCP separates the two deliberately and clients treat them very differently.
 * A JSON-RPC error means the call could not be made and is surfaced to the
 * person as a broken connection; a tool result with `isError` is handed back
 * to the MODEL, which can read it and do something else.
 *
 * "You do not hold deposit:refund" and "there is no customer with that id" are
 * facts the model should act on: ask the user, pick another record, stop. Sent
 * as JSON-RPC errors they become "the OpenTradesOS server is failing", which
 * is both wrong and unactionable.
 */
const toolError = (id: string | number | null | undefined, message: string): Response =>
  rpc(id, { content: [{ type: "text", text: message }], isError: true });

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  if (request.method !== "POST") {
    return rpcError(null, INVALID_REQUEST, "This endpoint speaks JSON-RPC over POST.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return rpcError(null, PARSE_ERROR, "Request body is not valid JSON.");
  }

  /**
   * A batch is refused rather than half-handled.
   *
   * The current revision of MCP removed JSON-RPC batching. Accepting an array
   * and answering only its first element would look like it worked.
   */
  if (Array.isArray(payload)) {
    return rpcError(null, INVALID_REQUEST, "Batched requests are not supported.");
  }
  if (payload === null || typeof payload !== "object") {
    return rpcError(null, INVALID_REQUEST, "A JSON-RPC request must be an object.");
  }

  const message = payload as JsonRpcRequest;
  if (typeof message.method !== "string") {
    return rpcError(message.id, INVALID_REQUEST, "No method named.");
  }

  /**
   * A notification has no id and takes no reply.
   *
   * `notifications/initialized` arrives from every client immediately after
   * the handshake. Answering it with a JSON-RPC response is a protocol
   * violation, and the clients that check disconnect on it.
   */
  const isNotification = message.id === undefined || message.id === null;

  switch (message.method) {
    case "initialize":
      return rpc(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        /**
         * Tools only, and `listChanged` is true because the list genuinely
         * does change: it is filtered by what the caller holds, so revoking a
         * permission changes it mid-session.
         */
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: deps.serverName ?? "opentradesos",
          version: deps.version ?? "0.0.0",
        },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202 });

    case "ping":
      return isNotification ? new Response(null, { status: 202 }) : rpc(message.id, {});

    case "tools/list": {
      const actor = await deps.resolveActor(request);
      /**
       * An unauthenticated list is EMPTY, not the whole catalogue.
       *
       * Answering with every tool would let anybody who can reach the port
       * enumerate the product's entire surface, including which modules a
       * company has, before presenting a credential.
       */
      const tools = actor ? toolsFor(actor) : [];
      return rpc(message.id, { tools: tools.map(publicShape) });
    }

    case "tools/call": {
      const params = message.params ?? {};
      const name = params.name;
      if (typeof name !== "string") {
        return rpcError(message.id, INVALID_PARAMS, "A tool call must name a tool.");
      }

      const actor = await deps.resolveActor(request);
      if (!actor) return toolError(message.id, "Not signed in. Present a valid credential.");

      const tool = allTools().find((t) => t.name === name);
      /**
       * Looked up in the FULL list and then checked, rather than looked up in
       * the caller's filtered list.
       *
       * Those two produce the same refusal for different reasons, and the
       * difference is what the agent does next. "No such tool" sends a model
       * hunting for a spelling mistake in a name it got from this server.
       * "You do not hold deposit:refund" tells the user what to ask for.
       */
      if (!tool) return toolError(message.id, `No tool named ${name}.`);

      const visible = toolsFor(actor).some((t) => t.name === name);
      if (!visible) {
        return toolError(
          message.id,
          `${name} needs ${tool.permissions.join(", ")}, which this connection does not hold. `
          + "Ask whoever administers this account to grant it.",
        );
      }

      const args = params.arguments;
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
        return rpcError(message.id, INVALID_PARAMS, "Tool arguments must be an object.");
      }

      return callTool(message.id, tool, (args ?? {}) as Record<string, unknown>, request, deps);
    }

    default:
      return isNotification
        ? new Response(null, { status: 202 })
        : rpcError(message.id, METHOD_NOT_FOUND, `This server does not implement ${message.method}.`);
  }
}

/** What goes over the wire. The route object is ours and stays here. */
const publicShape = (tool: McpTool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: tool.annotations,
});

/**
 * WHAT A TOOL CALL BECOMES ON THE WIRE.
 *
 * Exported and pure, so the translation can be asserted directly. It was
 * inline, and the test that claimed to check it only proved that the call
 * succeeded: removing the line that takes a path parameter out of the body
 * left the whole suite green, because the dispatcher lets the path win and
 * the duplicate was harmless. A guard that cannot fail is not a guard, and
 * the fix is a seam rather than a weaker claim.
 *
 * Returns a refusal string instead of a Request when the arguments cannot
 * make one.
 */
export function requestFor(
  tool: McpTool,
  args: Record<string, unknown>,
  credentials: Headers,
): Request | { refusal: string } {
  const { [IDEMPOTENCY_FIELD]: idempotencyKey, ...rest } = args;

  if (tool.route.idempotent && typeof idempotencyKey !== "string") {
    /**
     * Refused before the call, not defaulted.
     *
     * The tempting thing is to mint a key here when one is missing. That
     * turns every retry into a distinct intent, which on a payment route
     * means a second charge, and it does it invisibly: the tool succeeds
     * twice and the only record of the mistake is a customer's statement.
     */
    return {
      refusal:
        `${tool.name} changes money or creates a record and needs ${IDEMPOTENCY_FIELD}. `
        + "Choose a value, and send the same one if you retry.",
    };
  }

  /**
   * Path parameters come out of the arguments and go into the URL.
   *
   * Removed from the body rather than left in both. The dispatcher merges
   * query, body and path and lets the path win, so a duplicate would not
   * change the outcome today. It would mean two copies of one id in a single
   * request, and the day they disagree somebody has to read the dispatcher
   * to find out which one the server used.
   */
  const params = [...tool.route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  let path = tool.route.path;
  const body: Record<string, unknown> = { ...rest };
  for (const param of params) {
    const value = body[param];
    if (value === undefined || value === null) {
      return { refusal: `${tool.name} needs ${param}.` };
    }
    path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
    delete body[param];
  }

  const method = tool.route.method.toUpperCase();
  const url = new URL(`http://mcp.local${path}`);

  /**
   * A GET carries its input in the query string, because that is what the
   * dispatcher parses for a GET. Building one with a body would produce a
   * call whose every argument was silently dropped.
   */
  if (method === "GET" || method === "DELETE") {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers(credentials);
  headers.set("content-type", "application/json");
  if (typeof idempotencyKey === "string") headers.set("idempotency-key", idempotencyKey);

  return new Request(url.toString(), {
    method,
    headers,
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * The credential is forwarded verbatim rather than re-minted.
 *
 * `dispatch` resolves the caller itself, through the same path an HTTP
 * request takes. Synthesising a header here would be this file deciding who
 * the caller is, which is precisely the second gate the whole design exists
 * to avoid.
 */
function credentialsOf(original: Request): Headers {
  const headers = new Headers();
  const auth = original.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const cookie = original.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

async function callTool(
  id: string | number | null | undefined,
  tool: McpTool,
  args: Record<string, unknown>,
  original: Request,
  deps: McpDeps,
): Promise<Response> {
  const built = requestFor(tool, args, credentialsOf(original));
  if ("refusal" in built) return toolError(id, built.refusal);
  const proxied = built;

  const response = await dispatch(proxied, deps);
  const text = await response.text();

  if (!response.ok) {
    /**
     * The dispatcher's own message, not a generic failure.
     *
     * It already says the useful thing: which field failed validation, which
     * permission was missing, that the period is closed. Replacing it with
     * "the call failed" throws away the only part a model could act on.
     */
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; issues?: unknown };
      if (typeof parsed.error === "string") {
        detail = parsed.issues
          ? `${parsed.error}: ${JSON.stringify(parsed.issues)}`
          : parsed.error;
      }
    } catch { /* not JSON, so the body is the message */ }
    return toolError(id, detail);
  }

  /**
   * The result travels as text AND as structured content.
   *
   * `content` is what every client renders and what older ones can read;
   * `structuredContent` is the parsed value, so a client that supports it
   * does not have to parse a string a model has already been shown. Sending
   * only the structured half means the result is invisible in half the
   * clients in existence.
   */
  let structured: unknown;
  try { structured = JSON.parse(text); } catch { structured = undefined; }

  return rpc(id, {
    content: [{ type: "text", text: text === "" ? "null" : text }],
    ...(structured !== undefined && structured !== null && typeof structured === "object"
      ? { structuredContent: structured }
      : {}),
    isError: false,
  });
}
