import { z } from "zod";
import type { Database } from "@opentradesos/db";
import { packById } from "@opentradesos/trade-packs";
import * as operator from "../services/operator";
import { knownZone } from "../services/organizations";
import { publicBaseUrl } from "../services/setup-tokens";
import { presentsToken } from "./bearer";
import { problem, json, errorResponse } from "./problem";

/**
 * THE OPERATOR API, OVER HTTP
 *
 * Five routes for whoever runs a deployment with several companies in it.
 * The service layer behind them is services/operator.ts and the reader's
 * version is docs/self-hosting/operator-api.md.
 *
 * Deliberately NOT in the contracts. Everything there is published: it
 * becomes the OpenAPI document, the SDK and the MCP tool list, and an MCP
 * client listing "suspend organization" to a company's own AI agent is the
 * wrong kind of discoverable even when the call would be refused. So the
 * routes are a short table here, matched by hand, and the price of that is
 * this file, which is small.
 *
 * OFF UNLESS CONFIGURED. With no token every path below `/v1/operator` gets
 * the same 404 an unknown route gets, so a deployment that never turned it on
 * does not even reveal that it exists.
 */

export interface OperatorConfig {
  /** From `configuredToken("OPERATOR_TOKEN")`. Null means off. */
  token?: string | null | undefined;
  /** Where first-password links point. Defaults to PUBLIC_URL, then AUTH_URL. */
  publicUrl?: string | undefined;
}

const PREFIX = "/v1/operator";

export const isOperatorPath = (path: string): boolean =>
  path === PREFIX || path.startsWith(`${PREFIX}/`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bodies. Validated here rather than trusted, and the two checks that are
 * not shape checks matter most: a timezone this runtime cannot format would
 * crash every booking page the company ever serves, and an unknown trade pack
 * would otherwise surface as a 404 for a company that was half created.
 */
const CreateOrganization = z.object({
  name: z.string().trim().min(1).max(200),
  timezone: z.string().max(64).refine(knownZone, "Not a timezone this server knows"),
  tradePack: z.string().refine((id) => Boolean(packById(id)), "No trade pack with that id").optional(),
  externalRef: z.string().trim().min(1).max(200),
  owner: z.object({
    email: z.string().trim().email().max(320),
    name: z.string().trim().min(1).max(120),
  }),
});

const Suspend = z.object({ reason: z.string().trim().min(1).max(1000) });

type Route =
  | { kind: "create" }
  | { kind: "get" | "usage" | "suspend" | "resume"; id: string };

/** The route for a path, the methods it accepts, or nothing. */
function route(path: string): { route: Route; method: "GET" | "POST" } | null {
  const parts = path.slice(PREFIX.length).split("/").filter(Boolean);
  if (parts[0] !== "organizations") return null;
  if (parts.length === 1) return { route: { kind: "create" }, method: "POST" };
  const id = parts[1]!;
  if (parts.length === 2) return { route: { kind: "get", id }, method: "GET" };
  if (parts.length === 3) {
    if (parts[2] === "usage") return { route: { kind: "usage", id }, method: "GET" };
    if (parts[2] === "suspend") return { route: { kind: "suspend", id }, method: "POST" };
    if (parts[2] === "resume") return { route: { kind: "resume", id }, method: "POST" };
  }
  return null;
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  return JSON.parse(text);
}

const invalid = (error: z.ZodError): Response =>
  problem(422, "Request did not match the schema", {
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });

export async function handleOperator(
  request: Request,
  path: string,
  deps: OperatorConfig & { db: Database },
): Promise<Response> {
  const url = new URL(request.url);

  if (!deps.token) return problem(404, `No route for ${url.pathname}`);

  /**
   * Authentication before routing, so a caller without the token cannot map
   * which paths exist by watching for 404s and 405s. 401 rather than 404 once
   * the surface is on, because an operator whose token was rotated needs to be
   * told that, not told the API has gone.
   */
  if (!presentsToken(request, deps.token)) {
    return problem(401, "Operator token missing or wrong", {}, {
      "www-authenticate": 'Bearer realm="operator"',
    });
  }

  const found = route(path);
  if (!found) return problem(404, `No route for ${url.pathname}`);
  if (request.method !== found.method) {
    return problem(405, `${request.method} is not allowed on ${url.pathname}`,
      { allowed: [found.method] }, { allow: found.method });
  }

  // An id that is not a uuid cannot name a company, and passing it on would
  // be a cast error from Postgres reported as a 500.
  if (found.route.kind !== "create" && !UUID.test(found.route.id)) {
    return problem(404, "Organization not found");
  }

  const meta: operator.OperatorMeta = {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: request.headers.get("user-agent") ?? undefined,
  };

  try {
    const r = found.route;
    switch (r.kind) {
      case "create": {
        let raw: unknown;
        try {
          raw = await body(request);
        } catch {
          return problem(400, "Request body is not valid JSON");
        }
        const parsed = CreateOrganization.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);

        /**
         * Checked before anything is written. A company created with no
         * address to put in the owner's link is a company whose owner cannot
         * get in, and the operator would have nothing to send them.
         */
        const baseUrl = deps.publicUrl?.replace(/\/+$/, "") || publicBaseUrl();
        if (!baseUrl) {
          return problem(503, "PUBLIC_URL is not set, so there is nowhere to send the owner");
        }

        const result = await operator.create(deps.db, parsed.data, { baseUrl }, meta);
        return json(result, result.created ? 201 : 200);
      }

      case "get":
        return json(await operator.get(deps.db, r.id, meta), 200);

      case "usage": {
        const given = url.searchParams.get("since");
        const since = given
          ? new Date(given)
          : new Date(Date.now() - operator.DEFAULT_USAGE_DAYS * 864e5);
        if (Number.isNaN(since.getTime())) {
          return problem(422, "Request did not match the schema", {
            issues: [{ path: "since", message: "Expected an ISO 8601 date or time" }],
          });
        }
        return json(await operator.usage(deps.db, r.id, since, meta), 200);
      }

      case "suspend": {
        let raw: unknown;
        try {
          raw = await body(request);
        } catch {
          return problem(400, "Request body is not valid JSON");
        }
        const parsed = Suspend.safeParse(raw);
        if (!parsed.success) return invalid(parsed.error);
        return json(await operator.suspend(deps.db, r.id, parsed.data.reason, meta), 200);
      }

      case "resume":
        return json(await operator.resume(deps.db, r.id, meta), 200);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
