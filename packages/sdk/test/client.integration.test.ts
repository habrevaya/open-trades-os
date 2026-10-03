import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PassThrough } from "node:stream";
import postgres from "postgres";
import { createClient, type Database } from "@opentradesos/db";
import { apps } from "@opentradesos/api/services";
import { OpenTradesOS, OpenTradesOSError } from "../src/index";
import { bridge } from "../bin/opentradesos-mcp.mjs";
import { serve } from "./server";

/**
 * THE SDK AGAINST A RUNNING API
 *
 * Over a real socket, with an app token as the only credential, exactly as a
 * partner's integration runs. What is checked is what a partner relies on:
 * every call is authenticated, a POST is idempotent without the caller doing
 * anything, a retry after a dropped connection is not a second record, a list
 * pages to its end, a refusal arrives as an error carrying the server's words,
 * a bulk change can be dry run, and the MCP bridge carries a desktop client to
 * the hosted endpoint.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = "5d6f1c2e-4a3b-4c8d-9e0f-1a2b3c4d5e6f";
const USER = "6e7f2d3f-5b4c-4d9e-8f1a-2b3c4d5e6f7a";

let raw: postgres.Sql;
let db: Database;
let origin = "";
let close = async () => {};
let token = "";
let readOnlyToken = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  db = createClient(url);
  await raw.unsafe(`set session_replication_role = replica`);
  for (const table of ["oauth_refresh_token", "oauth_code", "app_token", "connected_app", "integration_event", "audit_log", "customer", "membership"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  await raw.unsafe(`set session_replication_role = origin`);
  await raw`delete from public.organization where id = ${ORG} or slug = 'sdk-co'`;
  await raw`delete from public."user" where id = ${USER} or email = 'sdk-co@test.local'`;
  await raw`insert into public.organization (id, name, slug) values (${ORG}, 'SDK Co', 'sdk-co')`;
  await raw`insert into public."user" (id, email) values (${USER}, 'sdk-co@test.local')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;

  const owner = { actor: { userId: USER, organizationId: ORG, roles: ["owner" as const] }, db };
  const app = await apps.install(owner, {
    name: "SDK test", permissions: ["customer:read", "customer:write"], scopes: { customer: "all" },
  });
  token = (await apps.issueToken(owner, { appId: app.id })).token;
  const reader = await apps.install(owner, { name: "Reader", permissions: ["customer:read"], scopes: { customer: "all" } });
  readOnlyToken = (await apps.issueToken(owner, { appId: reader.id })).token;

  const served = await serve(db);
  origin = served.origin;
  close = served.close;
});

afterAll(async () => {
  await close();
  if (raw) await raw.end();
  if (db) await db.$client.end();
});

const client = (over: Partial<ConstructorParameters<typeof OpenTradesOS>[0]> = {}) =>
  new OpenTradesOS({ baseUrl: origin, token, maxRetries: 2, ...over });

const newCustomer = (name: string, tags: string[] = []) => ({
  type: "residential" as const, name, paymentTermsDays: 0, taxExempt: false, tags, customFields: {},
});

run("calling the API", () => {
  it("says who it is, with the token", async () => {
    const me = await client().getAppSelf();
    expect(me.name).toBe("SDK test");
    expect(me.permissions).toEqual(["customer:read", "customer:write"]);
  });

  it("creates with an idempotency key it made itself, and a caller's key makes a retry a no-op", async () => {
    const a = await client().createCustomer(newCustomer("Ada SDK"));
    const b = await client().createCustomer(newCustomer("Bea SDK"));
    expect(a.id).not.toBe(b.id);

    const once = await client().createCustomer(newCustomer("Cy SDK"), { idempotencyKey: "sdk-cy-1" });
    const twice = await client().createCustomer(newCustomer("Cy SDK"), { idempotencyKey: "sdk-cy-1" });
    expect(twice.id).toBe(once.id);
  });

  it("retries a dropped connection with the same key, so there is one record, not two", async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls += 1;
      const response = await fetch(input, init);
      // The server did the work; the answer is lost on the way back.
      if (calls === 1) throw new TypeError("socket hang up");
      return response;
    };
    const created = await client({ fetch: flaky }).createCustomer(newCustomer("Dropped Dan"));
    expect(calls).toBe(2);
    const [row] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.customer where organization_id = ${ORG} and name = 'Dropped Dan'`;
    expect(row!.n).toBe(1);
    expect(created.name).toBe("Dropped Dan");
  });

  it("pages a list to its end", async () => {
    const names: string[] = [];
    for await (const customer of client().paginate("listCustomers", { limit: 1 })) names.push(customer.name);
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(new Set(names).size).toBe(names.length);
  });

  it("raises the server's own refusal: a permission, and the field that was wrong", async () => {
    const reader = client({ token: readOnlyToken });
    await expect(reader.createCustomer(newCustomer("Nope"))).rejects.toMatchObject({ status: 403 });
    const error = await client().createCustomer({ ...newCustomer(""), name: "" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenTradesOSError);
    expect((error as OpenTradesOSError).status).toBe(422);
    expect((error as OpenTradesOSError).issues.some((issue) => issue.path === "name")).toBe(true);
  });

  it("refuses a token that cannot be one before sending anything", () => {
    expect(() => new OpenTradesOS({ baseUrl: origin, token: "ots_abc def" })).toThrow(/not an OpenTradesOS app token/);
  });

  it("dry runs a bulk change, and nothing changes", async () => {
    await client().createCustomer(newCustomer("Tagged Tia", ["Lead"]));
    const report = await client().dryRun("renameCustomerTag", { from: "Lead", to: "Prospect" });
    expect(report.dryRun).toBe(true);
    expect(report.wouldReturn.customers).toBe(1);
    const [row] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.customer where organization_id = ${ORG} and tags ? 'Prospect'`;
    expect(row!.n).toBe(0);
  });
});

run("the MCP bridge", () => {
  async function converse(withToken: string, messages: unknown[]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
    const { done } = bridge({ url: origin, token: withToken, input, output, log: () => {} });
    for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    input.end();
    await done;
    return lines.map((line) => JSON.parse(line) as { id: number; result?: { tools?: Array<{ name: string }> }; error?: { code: number } });
  }

  it("carries a desktop client to the hosted endpoint with an app token", async () => {
    const replies = await converse(token, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(replies).toHaveLength(2);
    expect(replies[1]!.result!.tools!.some((tool) => tool.name === "otos_list_customers")).toBe(true);
    expect(replies[1]!.result!.tools!.some((tool) => tool.name === "otos_list_invoices")).toBe(false);
  });

  it("says so in the protocol when the token is refused", async () => {
    const replies = await converse("ots_revoked_or_never_was", [
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    // An answer to the request, carrying the reason, and nothing for the notification.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: 7, error: { code: -32001 } });
  });
});
