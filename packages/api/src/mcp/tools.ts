import type { Actor, Permission } from "@opentradesos/core";
import { permissionsFor } from "@opentradesos/core";
import { routes } from "../contracts/index";
import { toJsonSchema, type JsonSchema } from "../lib/json-schema";
import type { RouteDefinition } from "../lib/define";

/**
 * THE TOOL LIST, DERIVED FROM THE CONTRACTS
 *
 * The registry's own comment says "one definition, four consumers, no drift".
 * This is one of the consumers, and it is generated rather than written: a
 * hand-maintained tool list is a second description of the API that starts
 * correct and ends as the reason an agent calls an endpoint that was renamed
 * six months ago.
 *
 * Nothing here executes a call. A tool call is turned into a Request and
 * handed to the SAME dispatcher an HTTP client reaches, so there is exactly
 * one place a permission is checked. A second call path into the handlers
 * would be a second gate, and the second gate written is always the one that
 * forgets: this codebase has already shipped that mistake once, in a portal
 * boundary that copied two of three lines.
 */

/**
 * The prefix on every tool name.
 *
 * MCP tool names are flat and share a namespace with whatever else a client
 * has connected. `list` and `create` from four servers at once is how an
 * agent books a job into somebody's calendar app.
 */
const PREFIX = "otos";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * MCP's hints. They are hints and not enforcement, which is exactly why
   * they are worth getting right: a client uses them to decide what to run
   * without asking a person first, and a write mislabelled read only is a
   * confirmation prompt that never appears.
   */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  /** Carried so `tools/call` can reach the route without a second lookup. */
  route: RouteDefinition;
  routeName: string;
  permissions: readonly string[];
}

/**
 * The field an agent has to send on a retry, and the reason it is an argument
 * rather than something this server generates.
 *
 * An agent that times out calls the tool again with THE SAME ARGUMENTS. That
 * is the whole mechanism: if the key is an argument, a retry carries the
 * original key and the second call is a no-op. If this server minted one per
 * invocation, every retry would be a new key and therefore a second payment,
 * and the failure would only ever appear on a customer's card statement.
 *
 * So it is required. A caller who cannot be bothered to think of one gets a
 * refusal rather than a charge.
 */
export const IDEMPOTENCY_FIELD = "idempotencyKey";

const IDEMPOTENCY_SCHEMA: JsonSchema = {
  type: "string",
  minLength: 8,
  maxLength: 200,
  description:
    "A value you choose that identifies this intent. If the call fails or times out and you try again, "
    + "send the SAME value: the second call will return the first call's result instead of doing the work twice. "
    + "Use a new value only when you mean a genuinely new action.",
};

/**
 * A tool name from a route name.
 *
 * The route names are already unique keys in the registry, so uniqueness is
 * inherited rather than asserted. MCP requires names match a restricted
 * character set, which camelCase does not survive intact in every client, so
 * they are lowered with underscores.
 */
export const toolNameFor = (routeName: string): string =>
  `${PREFIX}_${routeName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;

/**
 * Every route that can be a tool at all, whoever is asking.
 *
 * Two exclusions, both of them about honesty rather than tidiness:
 *
 * `internal` routes are already excluded from the public API document. A tool
 * list is a published interface in exactly the same sense.
 *
 * Routes authorized by `grant` or `public` are NOT tools. A grant route's
 * authority IS its token, held by a customer who has no account, and an agent
 * connected as an application holds no such token: exposing the route would
 * produce a tool that is visible, callable and refuses every time. A public
 * route needs no credential and is reachable without this server at all.
 */
function eligible(): [string, RouteDefinition][] {
  return Object.entries(routes).filter(([, route]) => {
    const r = route as RouteDefinition;
    if (r.internal) return false;
    return (r.authorization ?? "session") === "session";
  }) as [string, RouteDefinition][];
}

function describe(routeName: string, route: RouteDefinition): McpTool {
  const input = toJsonSchema(route.input);

  /**
   * The idempotency field is added to the SCHEMA, not to the contract.
   *
   * Over HTTP the key travels in a header, which an MCP tool call has no room
   * for. Rather than teaching the contracts about a transport, the tool
   * carries it as an argument and the server lifts it back into a header
   * before dispatching. The contract stays the one description of the route.
   */
  const inputSchema: JsonSchema = route.idempotent
    ? {
        ...input,
        properties: { ...input.properties, [IDEMPOTENCY_FIELD]: IDEMPOTENCY_SCHEMA },
        required: [...(input.required ?? []), IDEMPOTENCY_FIELD],
      }
    : input;

  const readOnly = route.method === "get";

  /**
   * What the agent is told it needs, in the description.
   *
   * A tool that refuses with "forbidden" sends a person to support. A tool
   * whose description names the permission lets the agent say "ask whoever
   * administers this to grant invoice:void", which is an answer.
   */
  const permissionLine = route.permissions.length > 0
    ? `\n\nRequires: ${route.permissions.join(", ")}.`
    : "";

  const retryLine = route.idempotent
    ? `\n\nThis call changes money or creates a record. Send ${IDEMPOTENCY_FIELD}, and send the same value again if you retry.`
    : "";

  return {
    name: toolNameFor(routeName),
    title: route.summary,
    description: `${route.summary}.${route.description ? ` ${route.description}` : ""}${permissionLine}${retryLine}`,
    inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: route.method === "delete",
      /**
       * Only a route that carries an idempotency key can honestly claim this.
       * A GET is idempotent in the HTTP sense, and a client reading this hint
       * is asking whether repeating the call is safe, which for a read it is.
       */
      idempotentHint: readOnly || route.idempotent === true,
    },
    route,
    routeName,
    permissions: route.permissions,
  };
}

/** Every tool this server can ever offer. Not what any given caller sees. */
export const allTools = (): McpTool[] =>
  eligible().map(([name, route]) => describe(name, route));

/**
 * What THIS caller sees.
 *
 * Filtered by what they actually hold, and the filtering is not security:
 * `tools/call` runs through the dispatcher and the dispatcher checks the
 * permission again. It is about attention. A model handed ninety tools of
 * which it may call thirty will spend its reasoning discovering that by
 * failing, in front of a person waiting for an answer, and will often report
 * the refusal as though the underlying fact were unavailable rather than the
 * permission missing.
 *
 * Listing is therefore narrower than enforcement, never wider. If these two
 * ever disagree in the other direction, the dispatcher wins and the caller
 * sees a refusal, which is the safe way round.
 */
export function toolsFor(actor: Actor): McpTool[] {
  const held = permissionsFor(actor);
  return allTools().filter((tool) =>
    tool.permissions.every((p) => held.has(p as Permission)));
}
