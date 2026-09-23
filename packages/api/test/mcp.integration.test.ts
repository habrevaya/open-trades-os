import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { handleMcp, PROTOCOL_VERSION } from "../src/mcp/server";
import { allTools, toolNameFor, IDEMPOTENCY_FIELD } from "../src/mcp/tools";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * AN AGENT DRIVING THE PRODUCT, AGAINST A REAL DATABASE
 *
 * The unit test proves what is offered. This proves what happens when it is
 * called: that the tool reaches the same handler an HTTP client reaches, that
 * the permission is checked by the dispatcher and not by the tool list, and
 * that a refusal comes back as something a model can act on rather than as a
 * broken connection.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("mcp:org");
const USER = fixtureId("mcp:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

/** Every request carries who it is, the way the host resolves a credential. */
const deps = (roles: Actor["roles"] | null) => ({
  db: db(),
  resolveActor: async (): Promise<Actor | null> =>
    roles === null ? null : { userId: USER, organizationId: ORG, roles },
  resolveSession: async (): Promise<ServiceContext | null> =>
    roles === null ? null : { actor: { userId: USER, organizationId: ORG, roles }, db: db() },
});

const call = async (body: unknown, roles: Actor["roles"] | null = ["owner"], headers: Record<string, string> = {}) => {
  const response = await handleMcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    deps(roles),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : JSON.parse(text) as Record<string, unknown>,
  };
};

const rpcCall = (name: string, args: Record<string, unknown>, id = 1) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

const resultOf = (body: Record<string, unknown> | null) =>
  (body?.result ?? {}) as { content?: { text: string }[]; isError?: boolean; structuredContent?: unknown };

const textOf = (body: Record<string, unknown> | null) => resultOf(body).content?.[0]?.text ?? "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Agent Co", slug: "mcp-co" });
});
afterAll(async () => { if (raw) await raw.end(); });

run("the handshake", () => {
  it("answers initialize with a protocol version and tools", async () => {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const result = body!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.capabilities).toEqual({ tools: { listChanged: true } });
  });

  it("takes the initialized notification without answering it", async () => {
    /**
     * A notification has no id and takes no reply. Answering one is a
     * protocol violation, and the clients that check disconnect on it.
     */
    const { status, body } = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  it("refuses a batch rather than answering only its first element", async () => {
    const { body } = await call([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect((body!.error as { message: string }).message).toMatch(/batch/i);
  });

  it("answers a malformed body with a parse error rather than a crash", async () => {
    const response = await handleMcp(
      new Request("http://localhost/mcp", { method: "POST", body: "{not json" }),
      deps(["owner"]),
    );
    expect((await response.json() as { error: { code: number } }).error.code).toBe(-32700);
  });
});

run("listing", () => {
  it("lists nothing at all to a caller with no credential", async () => {
    /**
     * Not the whole catalogue. Anybody who can reach the port would otherwise
     * enumerate the product's entire surface, and which modules this company
     * runs, before presenting anything.
     */
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    expect((body!.result as { tools: unknown[] }).tools).toEqual([]);
  });

  it("lists fewer tools to a technician than to an owner", async () => {
    const asOwner = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ["owner"]);
    const asTech = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ["technician"]);

    const owner = (asOwner.body!.result as { tools: { name: string }[] }).tools;
    const tech = (asTech.body!.result as { tools: { name: string }[] }).tools;
    expect(tech.length).toBeLessThan(owner.length);
  });

  it("does not send the route object over the wire", async () => {
    // It carries zod schemas and a permission list shaped for this server's
    // own use. What a client needs is the published five fields.
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tool = (body!.result as { tools: Record<string, unknown>[] }).tools[0]!;
    expect(Object.keys(tool).sort()).toEqual(
      ["annotations", "description", "inputSchema", "name", "title"],
    );
  });
});

run("calling a tool", () => {
  it("reads through the same dispatcher an HTTP client reaches", async () => {
    const { body } = await call(rpcCall(toolNameFor("listCustomers"), { limit: 5 }));

    expect(resultOf(body).isError).toBe(false);
    const structured = resultOf(body).structuredContent as { data: unknown[] };
    expect(Array.isArray(structured.data)).toBe(true);
  });

  it("sends the result as text as well as structured content", async () => {
    /**
     * Structured content alone is invisible in every client that predates it,
     * and the text is what a model is shown.
     */
    const { body } = await call(rpcCall(toolNameFor("listCustomers"), { limit: 1 }));
    expect(textOf(body)).toContain("data");
  });

  it("creates a record, and the record is really there", async () => {
    const name = `Agent Made ${Date.now()}`;
    const { body } = await call(rpcCall(toolNameFor("createCustomer"), {
      type: "residential", name, paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
      [IDEMPOTENCY_FIELD]: `mcp-create-${Date.now()}`,
    }));

    expect(resultOf(body).isError).toBe(false);
    const rows = await raw`select id from public.customer
      where organization_id = ${ORG} and name = ${name}`;
    expect(rows).toHaveLength(1);
  });

  it("puts a path parameter in the URL and not in the body", async () => {
    /**
     * A path parameter left in the body as well means two copies of one id in
     * a single request, and the first time they disagree somebody has to work
     * out which one the server used.
     */
    const [customer] = await raw<{ id: string }[]>`insert into public.customer
      (organization_id, name) values (${ORG}, 'Path Param Co') returning id`;

    const { body } = await call(rpcCall(toolNameFor("getCustomer"), { id: customer!.id }));
    expect(resultOf(body).isError).toBe(false);
    expect(textOf(body)).toContain("Path Param Co");
  });
});

run("a refusal is a result, not a broken connection", () => {
  it("returns a tool error rather than a JSON-RPC error when a permission is missing", async () => {
    /**
     * A JSON-RPC error is surfaced to a person as a failing server. A tool
     * error goes back to the MODEL, which can read "you do not hold this" and
     * tell the user what to ask for. The difference is whether anybody finds
     * out what actually happened.
     */
    const { body } = await call(
      rpcCall(toolNameFor("createCustomer"), {
        type: "residential", name: "Nope", paymentTermsDays: 0,
        taxExempt: false, tags: [], customFields: {},
        [IDEMPOTENCY_FIELD]: "mcp-forbidden-1",
      }),
      ["technician"],
    );

    expect(body!.error).toBeUndefined();
    expect(resultOf(body).isError).toBe(true);
  });

  it("names the permission a hidden tool needs instead of denying the tool exists", async () => {
    const { body } = await call(
      rpcCall(toolNameFor("createCustomer"), { name: "x" }),
      ["technician"],
    );
    // "No such tool" sends a model hunting for a typo in a name we gave it.
    expect(textOf(body)).not.toMatch(/no tool named/i);

    /**
     * The permission is read off the contract rather than typed here. A
     * hard coded name makes this test a spelling check on my memory: the
     * first version asserted customer:create and the route requires
     * customer:write, so it failed for a reason that had nothing to do with
     * the property under test.
     */
    const tool = allTools().find((t) => t.name === toolNameFor("createCustomer"))!;
    expect(tool.permissions.length).toBeGreaterThan(0);
    for (const permission of tool.permissions) expect(textOf(body)).toContain(permission);
  });

  it("says no tool by that name when there really is none", async () => {
    const { body } = await call(rpcCall("otos_not_a_tool", {}));
    expect(textOf(body)).toMatch(/no tool named/i);
  });

  it("passes the dispatcher's validation detail through", async () => {
    /**
     * "The call failed" is unactionable. "limit: expected number, received
     * string" is a fix.
     */
    const { body } = await call(rpcCall(toolNameFor("listCustomers"), { limit: 9999 }));
    expect(resultOf(body).isError).toBe(true);
    expect(textOf(body)).toMatch(/limit/);
  });

  it("refuses a call with no credential", async () => {
    const { body } = await call(rpcCall(toolNameFor("listCustomers"), {}), null);
    expect(resultOf(body).isError).toBe(true);
    expect(textOf(body)).toMatch(/signed in|credential/i);
  });
});

run("a retry must not do the work twice", () => {
  it("refuses an idempotent write that carries no key", async () => {
    /**
     * The tempting alternative is to mint one here. That turns every retry
     * into a distinct intent, which on a payment route is a second charge,
     * and the only record of the mistake is a customer's statement.
     */
    const { body } = await call(rpcCall(toolNameFor("createCustomer"), {
      type: "residential", name: "No Key Co", paymentTermsDays: 0,
      taxExempt: false, tags: [], customFields: {},
    }));

    expect(resultOf(body).isError).toBe(true);
    expect(textOf(body)).toContain(IDEMPOTENCY_FIELD);

    const rows = await raw`select id from public.customer
      where organization_id = ${ORG} and name = 'No Key Co'`;
    expect(rows).toHaveLength(0);
  });
});
