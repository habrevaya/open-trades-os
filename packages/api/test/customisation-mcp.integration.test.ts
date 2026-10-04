import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { handleMcp } from "../src/mcp/server";
import { allTools, toolsFor } from "../src/mcp/tools";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * AN AGENT CUSTOMISING THE COMPANY, WITH THE SAME PERMISSIONS AS THE SCREENS
 *
 * The tools are generated from the routes, so "MCP tools to define custom
 * fields and objects and to read and edit workflows" is the routes existing,
 * declaring the permissions their services enforce, and offering a dry run.
 * This proves each from the agent's side of the wire: what an agent is
 * offered depends on who it acts as, a dry run changes nothing and says what
 * it would have done, the real call does it, and a refusal comes back as a
 * result the model can read rather than a broken connection.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("mcpcust:org");
const USER = fixtureId("mcpcust:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const actor = (roles: Actor["roles"]): Actor => ({ userId: USER, organizationId: ORG, roles });

let id = 0;
async function tool(name: string, args: Record<string, unknown>, roles: Actor["roles"] = ["owner"]) {
  id += 1;
  const response = await handleMcp(new Request("http://x/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  }), {
    db: db(),
    resolveActor: async () => actor(roles),
    resolveSession: async (): Promise<ServiceContext> => ({ actor: actor(roles), db: db() }),
  });
  const body = await response.json() as {
    result: { isError: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  };
  return body.result;
}

const count = async (table: string) =>
  Number((await raw.unsafe<{ n: string }[]>(`select count(*) as n from public.${table} where organization_id = $1`, [ORG]))[0]!.n);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Agent Custom Co", slug: "agent-custom-co" });
});
afterAll(async () => { if (raw) await raw.end(); });
beforeEach(async () => {
  if (!url) return;
  for (const table of [
    "workflow_version", "workflow", "custom_object_record", "custom_object_type",
    "custom_field_definition", "integration_event", "audit_log",
  ]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

run("what an agent is offered", () => {
  const names = (roles: Actor["roles"]) => new Set(toolsFor(actor(roles)).map((t) => t.name));

  it("offers defining fields, kinds of record and workflows, each with a dry run", () => {
    for (const name of [
      "otos_define_custom_field", "otos_update_custom_field", "otos_delete_custom_field",
      "otos_define_custom_object", "otos_update_custom_object", "otos_delete_custom_object",
      "otos_create_workflow", "otos_publish_workflow", "otos_delete_workflow",
      "otos_import_custom_records", "otos_copy_back_from_sandbox",
    ]) {
      const found = allTools().find((t) => t.name === name);
      expect(found, name).toBeDefined();
      expect(found!.inputSchema.properties, name).toHaveProperty("dryRun");
    }
    expect(allTools().find((t) => t.name === "otos_get_workflow")!.annotations.readOnlyHint).toBe(true);
  });

  it("offers each only to whoever the screens would let do it", () => {
    const owner = names(["owner"]);
    expect(owner.has("otos_define_custom_object")).toBe(true);
    expect(owner.has("otos_publish_workflow")).toBe(true);

    /** The office manager reads automations and changes none, as on `/automations`. */
    const office = names(["office_manager"]);
    expect(office.has("otos_get_workflow")).toBe(true);
    expect(office.has("otos_publish_workflow")).toBe(false);
    expect(office.has("otos_define_custom_field")).toBe(false);
    expect(office.has("otos_create_custom_record")).toBe(true);

    const technician = names(["technician"]);
    expect(technician.has("otos_list_custom_records")).toBe(true);
    expect(technician.has("otos_create_custom_record")).toBe(false);
  });
});

run("defining a kind of record and its fields", () => {
  it("tries it first, changing nothing, then does it", async () => {
    const tried = await tool("otos_define_custom_object", {
      key: "permit", label: "Permit", titleLabel: "Permit number", links: ["job"],
      dryRun: true, idempotencyKey: "agent-define-permit",
    });
    expect(tried.isError).toBe(false);
    expect(tried.structuredContent).toMatchObject({
      dryRun: true,
      wouldReturn: { key: "permit", label: "Permit", pluralLabel: "Permits" },
      tables: expect.arrayContaining([expect.objectContaining({ table: "custom_object_type", inserted: 1 })]),
      audit: [expect.objectContaining({ action: "custom_object_type.defined" })],
    });
    expect(await count("custom_object_type")).toBe(0);

    const done = await tool("otos_define_custom_object", {
      key: "permit", label: "Permit", titleLabel: "Permit number", links: ["job"], idempotencyKey: "agent-define-permit",
    });
    expect(done.isError).toBe(false);
    expect(await count("custom_object_type")).toBe(1);

    /** The same key again, as a retry: the first answer, not a second kind or a refusal. */
    const again = await tool("otos_define_custom_object", {
      key: "permit", label: "Permit", titleLabel: "Permit number", links: ["job"], idempotencyKey: "agent-define-permit",
    });
    expect(again.isError).toBe(false);
    expect(await count("custom_object_type")).toBe(1);

    const field = await tool("otos_define_custom_field", {
      entityType: "object:permit", key: "status", label: "Status", dataType: "select",
      options: ["applied", "approved"], dryRun: true, idempotencyKey: "agent-define-status",
    });
    expect(field.structuredContent).toMatchObject({ dryRun: true, wouldReturn: { entityType: "object:permit", key: "status" } });
    expect(await count("custom_field_definition")).toBe(0);
    expect((await tool("otos_define_custom_field", {
      entityType: "object:permit", key: "status", label: "Status", dataType: "select",
      options: ["applied", "approved"], idempotencyKey: "agent-define-status",
    })).isError).toBe(false);
    expect(await count("custom_field_definition")).toBe(1);
  });

  it("is refused to an agent acting for somebody who may not, naming the permission", async () => {
    const refused = await tool("otos_define_custom_object", {
      key: "permit", label: "Permit", idempotencyKey: "agent-office-permit",
    }, ["office_manager"]);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("customfield:write");
  });
});

run("reading and editing a workflow", () => {
  const definition = {
    name: "Chase a new permit",
    triggerKind: "event",
    triggerEvents: ["record.created"],
    conditions: { all: [{ path: "record.type", op: "eq", value: "permit" }] },
    steps: [{ kind: "create_task", config: { title: "Call the inspector", queue: "office" } }],
  };

  it("writes one switched off after a dry run, reads it back, and publishes a new version", async () => {
    const tried = await tool("otos_create_workflow", { ...definition, dryRun: true, idempotencyKey: "agent-flow-1" });
    expect(tried.structuredContent).toMatchObject({ dryRun: true, wouldReturn: { name: "Chase a new permit", enabled: false, version: 1 } });
    expect(await count("workflow")).toBe(0);

    const made = await tool("otos_create_workflow", { ...definition, idempotencyKey: "agent-flow-1" });
    expect(made.isError).toBe(false);
    const flowId = (made.structuredContent as { id: string }).id;

    const read = await tool("otos_get_workflow", { id: flowId }, ["office_manager"]);
    expect(read.structuredContent).toMatchObject({
      id: flowId, enabled: false, version: 1, triggerEvents: ["record.created"],
      conditions: definition.conditions, steps: definition.steps,
      requiredPermissions: ["task:write"],
    });

    const published = await tool("otos_publish_workflow", {
      id: flowId, ...definition,
      steps: [{ kind: "create_task", config: { title: "Call the inspector today", queue: "office" } }],
      idempotencyKey: "agent-flow-1-v2",
    });
    expect(published.structuredContent).toMatchObject({ version: 2, steps: [{ config: { title: "Call the inspector today" } }] });
    expect(await count("workflow_version")).toBe(2);
  });

  it("refuses what the canvas would refuse, in words, as a result the model can read", async () => {
    const dead = await tool("otos_create_workflow", {
      ...definition, triggerEvents: ["permit.approved"], idempotencyKey: "agent-flow-dead",
    });
    expect(dead.isError).toBe(true);
    expect(dead.content[0]!.text).toContain("Nothing in this product emits permit.approved");

    const office = await tool("otos_create_workflow", { ...definition, idempotencyKey: "agent-flow-office" }, ["office_manager"]);
    expect(office.isError).toBe(true);
    expect(office.content[0]!.text).toContain("workflow:write");
  });

  it("cannot publish a step its author could not, which is the escalation the check exists for", async () => {
    /** A dispatcher given workflow:write still may not raise tasks; the publish says so. */
    const response = await handleMcp(new Request("http://x/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 99, method: "tools/call",
        params: { name: "otos_create_workflow", arguments: { ...definition, idempotencyKey: "agent-flow-escalate" } },
      }),
    }), {
      db: db(),
      resolveActor: async () => ({ ...actor(["dispatcher"]), grants: ["workflow:write"] }),
      resolveSession: async () => ({ actor: { ...actor(["dispatcher"]), grants: ["workflow:write"] }, db: db() }),
    });
    const body = await response.json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain("You do not hold: task:write");
    expect(await count("workflow")).toBe(0);
  });
});
