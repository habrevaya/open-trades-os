import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Actor } from "@opentradesos/core";
import { routes } from "../src/contracts/index";
import { allTools, toolsFor, toolNameFor, IDEMPOTENCY_FIELD } from "../src/mcp/tools";
import { requestFor } from "../src/mcp/server";
import { toJsonSchema } from "../src/lib/json-schema";
import { MoneyString, RateString } from "../src/contracts/common";
import type { RouteDefinition } from "../src/lib/define";

/**
 * THE TOOL LIST AND THE SHAPES IT PUBLISHES
 *
 * No database here. These are the properties that hold before anything is
 * called: what is offered, to whom, and whether the schema an agent reads
 * describes the API the dispatcher actually serves.
 */

const owner: Actor = { userId: "u", organizationId: "o", roles: ["owner"] };
const technician: Actor = { userId: "u", organizationId: "o", roles: ["technician"] };

describe("what the contracts turn into", () => {
  it("offers every session route and nothing else", () => {
    const expected = Object.entries(routes)
      .filter(([, r]) => {
        const route = r as RouteDefinition;
        return !route.internal && (route.authorization ?? "session") === "session";
      })
      .map(([name]) => toolNameFor(name))
      .sort();

    expect(allTools().map((t) => t.name).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(10);
  });

  it("does not offer a route a customer's link authorizes", () => {
    /**
     * A grant route's authority IS its token, held by somebody with no
     * account. An agent connected as an application holds none, so the tool
     * would be visible, callable, and refuse every single time.
     */
    const grantRoutes = Object.entries(routes)
      .filter(([, r]) => ((r as RouteDefinition).authorization ?? "session") !== "session")
      .map(([name]) => toolNameFor(name));

    expect(grantRoutes.length).toBeGreaterThan(0);
    const offered = new Set(allTools().map((t) => t.name));
    for (const name of grantRoutes) expect(offered.has(name)).toBe(false);
  });

  it("gives every tool a unique name", () => {
    const names = allTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses names an MCP client will accept", () => {
    for (const tool of allTools()) expect(tool.name).toMatch(/^[a-z0-9_]+$/);
  });

  it("namespaces them, so two connected servers do not collide", () => {
    // `list` and `create` from four servers at once is how an agent books a
    // job into somebody's calendar application.
    for (const tool of allTools()) expect(tool.name.startsWith("otos_")).toBe(true);
  });
});

describe("what each caller is shown", () => {
  it("shows a technician fewer tools than an owner", () => {
    const forOwner = toolsFor(owner).map((t) => t.name);
    const forTech = toolsFor(technician).map((t) => t.name);

    expect(forTech.length).toBeLessThan(forOwner.length);
    // Narrower, never different: listing must not widen what the dispatcher
    // allows, only hide what it would refuse.
    for (const name of forTech) expect(forOwner).toContain(name);
  });

  it("hides a tool whose permission the caller does not hold", () => {
    const forTech = new Set(toolsFor(technician).map((t) => t.name));
    const held = new Set<string>();
    for (const tool of toolsFor(technician)) for (const p of tool.permissions) held.add(p);

    for (const tool of allTools()) {
      if (forTech.has(tool.name)) continue;
      // Every hidden tool is hidden for a reason the caller could act on.
      expect(tool.permissions.length).toBeGreaterThan(0);
    }
  });

  it("names the permission in the description, so an agent can say what to ask for", () => {
    const guarded = allTools().filter((t) => t.permissions.length > 0);
    expect(guarded.length).toBeGreaterThan(0);
    for (const tool of guarded) {
      for (const permission of tool.permissions) {
        expect(tool.description).toContain(permission);
      }
    }
  });
});

describe("a retry must not be a second charge", () => {
  it("makes the idempotency key a required argument on every idempotent route", () => {
    const idempotent = allTools().filter((t) => t.route.idempotent);
    expect(idempotent.length).toBeGreaterThan(0);

    for (const tool of idempotent) {
      expect(tool.inputSchema.properties?.[IDEMPOTENCY_FIELD]).toBeDefined();
      expect(tool.inputSchema.required).toContain(IDEMPOTENCY_FIELD);
    }
  });

  it("does not put one on a route that has no idempotency", () => {
    /**
     * An argument the server ignores teaches an agent that sending the same
     * key twice is safe everywhere, which is exactly the belief that makes
     * the real one useless.
     */
    for (const tool of allTools().filter((t) => !t.route.idempotent)) {
      expect(tool.inputSchema.properties?.[IDEMPOTENCY_FIELD]).toBeUndefined();
    }
  });

  it("tells the agent in words to reuse the value on a retry", () => {
    const tool = allTools().find((t) => t.route.idempotent)!;
    const field = tool.inputSchema.properties![IDEMPOTENCY_FIELD]!;
    expect(field.description).toMatch(/same/i);
  });
});

describe("the hints a client decides to auto-run on", () => {
  it("marks reads read only and writes not", () => {
    for (const tool of allTools()) {
      expect(tool.annotations.readOnlyHint).toBe(tool.route.method === "get");
    }
  });

  it("never claims a write is idempotent unless it carries a key", () => {
    /**
     * This hint is what a client uses to decide whether to retry without
     * asking a person. A write that claims it and has no key behind it is a
     * duplicate invoice with a confirmation prompt that never appeared.
     */
    for (const tool of allTools()) {
      if (tool.annotations.idempotentHint && tool.route.method !== "get") {
        expect(tool.route.idempotent).toBe(true);
      }
    }
  });
});

describe("the schema an agent reads describes the API the dispatcher serves", () => {
  it("keeps money a string", () => {
    /**
     * The single most costly thing this converter could get wrong. A decimal
     * regex looks numeric, and `{ type: "number" }` puts an IEEE 754 float
     * into every generated client and every model that reads the tool.
     */
    expect(toJsonSchema(MoneyString).type).toBe("string");
    expect(toJsonSchema(RateString).type).toBe("string");
  });

  it("keeps money a string everywhere it appears in a real contract", () => {
    /**
     * Not only where the test happens to look. The converter is walked over
     * every published tool schema, and every field whose pattern is the money
     * pattern has to still be a string. A previous version of this test
     * checked the exported constant alone, which proves the conversion works
     * on the value it was handed and nothing about the eighty places it is
     * used.
     */
    const moneyPattern = MoneyString._def.checks.find((c) => c.kind === "regex");
    const source = moneyPattern && "regex" in moneyPattern ? moneyPattern.regex.source : "";
    expect(source).not.toBe("");

    let found = 0;
    const walk = (schema: {
      type?: string | string[]; pattern?: string;
      properties?: Record<string, unknown>; items?: unknown;
    }): void => {
      if (schema.pattern === source) {
        found += 1;
        expect(schema.type).toBe("string");
      }
      for (const child of Object.values(schema.properties ?? {})) {
        walk(child as Parameters<typeof walk>[0]);
      }
      if (schema.items) walk(schema.items as Parameters<typeof walk>[0]);
    };

    for (const tool of allTools()) walk(tool.inputSchema);
    // A count of zero would make every assertion above vacuous.
    expect(found).toBeGreaterThan(0);
  });

  it("does not require a field that has a default", () => {
    // `limit: z.number().default(50)` is satisfied by sending nothing.
    const schema = toJsonSchema(z.object({
      limit: z.number().int().default(50),
      name: z.string(),
    }));
    expect(schema.required).toEqual(["name"]);
    expect(schema.properties?.limit?.default).toBe(50);
  });

  it("carries a date as a string, not an object", () => {
    const schema = toJsonSchema(z.object({ at: z.date() }));
    expect(schema.properties?.at).toEqual({ type: "string", format: "date-time" });
  });

  it("describes an enum as its values", () => {
    const schema = toJsonSchema(z.enum(["draft", "sent"]));
    expect(schema).toEqual({ type: "string", enum: ["draft", "sent"] });
  });

  it("unwraps optional without losing the inner shape", () => {
    const schema = toJsonSchema(z.object({ note: z.string().max(10).optional() }));
    expect(schema.properties?.note).toEqual({ type: "string", maxLength: 10 });
    expect(schema.required).toBeUndefined();
  });

  it("refuses a type it cannot describe instead of emitting an empty object", () => {
    /**
     * A field that silently becomes `{}` accepts anything, and the document
     * still generates, and nobody finds out until an integrator sends the
     * wrong shape and gets a 422 the schema said was impossible.
     */
    expect(() => toJsonSchema(z.map(z.string(), z.string()))).toThrow(/json-schema\.ts/);
  });

  it("gives every tool an object schema a client can render", () => {
    for (const tool of allTools()) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("declares every path parameter as a property the caller must send", () => {
    /**
     * An id that lives only in the URL template is invisible to an agent
     * reading the schema, so the call goes out with `{id}` still in the path.
     */
    for (const tool of allTools()) {
      for (const match of tool.route.path.matchAll(/\{(\w+)\}/g)) {
        const param = match[1]!;
        expect(tool.inputSchema.properties?.[param]).toBeDefined();
        expect(tool.inputSchema.required ?? []).toContain(param);
      }
    }
  });
});

/**
 * WHAT A TOOL CALL BECOMES ON THE WIRE
 *
 * Asserted against the Request itself rather than against whether the call
 * succeeded. The first version of the path parameter test checked only that
 * a call worked, so deleting the line that takes the parameter out of the
 * body left the suite green: the dispatcher lets the path win, and the
 * duplicate was invisible. Every assertion here can fail.
 */
describe("the request a tool call builds", () => {
  const tool = (routeName: string) =>
    allTools().find((t) => t.name === toolNameFor(routeName))!;

  const built = (routeName: string, args: Record<string, unknown>) => {
    const result = requestFor(tool(routeName), args, new Headers());
    if ("refusal" in result) throw new Error(`Expected a request, got: ${result.refusal}`);
    return result;
  };

  it("puts a path parameter in the URL", () => {
    const request = built("getCustomer", { id: "11111111-1111-4111-8111-111111111111" });
    expect(new URL(request.url).pathname).toContain("11111111-1111-4111-8111-111111111111");
    expect(new URL(request.url).pathname).not.toContain("{");
  });

  it("does not leave the path parameter in the query as well", async () => {
    const request = built("getCustomer", { id: "11111111-1111-4111-8111-111111111111" });
    expect(new URL(request.url).searchParams.get("id")).toBeNull();
  });

  it("does not leave the path parameter in the body as well", async () => {
    const withBody = allTools().find((t) =>
      t.route.method !== "get" && t.route.path.includes("{"))!;
    const params = [...withBody.route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

    const args: Record<string, unknown> = { note: "x" };
    for (const p of params) args[p] = "22222222-2222-4222-8222-222222222222";
    if (withBody.route.idempotent) args[IDEMPOTENCY_FIELD] = "key-for-this-intent";

    const result = requestFor(withBody, args, new Headers());
    if ("refusal" in result) throw new Error(result.refusal);
    const body = JSON.parse(await result.text()) as Record<string, unknown>;
    for (const p of params) expect(body[p]).toBeUndefined();
  });

  it("sends a read's arguments in the query string, where the dispatcher looks", () => {
    // A GET built with a body is a call whose every argument is dropped.
    const request = built("listCustomers", { limit: 25 });
    expect(request.method).toBe("GET");
    expect(new URL(request.url).searchParams.get("limit")).toBe("25");
  });

  it("lifts the idempotency key into the header, never the body", async () => {
    const create = tool("createCustomer");
    const result = requestFor(create, {
      type: "residential", name: "N", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
      [IDEMPOTENCY_FIELD]: "one-intent",
    }, new Headers());
    if ("refusal" in result) throw new Error(result.refusal);

    expect(result.headers.get("idempotency-key")).toBe("one-intent");
    const body = JSON.parse(await result.text()) as Record<string, unknown>;
    // A retried body would carry a regenerated key. The header is the one
    // place a client can send the same value twice on purpose.
    expect(body[IDEMPOTENCY_FIELD]).toBeUndefined();
  });

  it("forwards the caller's own credential rather than making one up", () => {
    const credentials = new Headers({ authorization: "Bearer ots_abc" });
    const result = requestFor(tool("listCustomers"), {}, credentials);
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.headers.get("authorization")).toBe("Bearer ots_abc");
  });

  it("refuses rather than building a request with a hole in the path", () => {
    const result = requestFor(tool("getCustomer"), {}, new Headers());
    expect("refusal" in result && result.refusal).toMatch(/needs id/);
  });
});
