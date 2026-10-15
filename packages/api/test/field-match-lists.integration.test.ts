import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as fields from "../src/services/custom-fields";
import * as jobs from "../src/services/jobs";
import * as people from "../src/services/people";
import * as objects from "../src/services/custom-objects";
import { dispatch } from "../src/http/dispatch";
import { memberActor } from "../src/services/session";
import { inTenant, ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * "ANY OF THESE" ON EVERY LIST THAT FILTERS BY FIELDS
 *
 * The customer list and the report builder could join fields by "or"; the
 * job, invoice, estimate and people lists and a kind of record's own list
 * joined them by "and" only. Each now takes `fieldMatch`, joined by the same
 * `listFilter` the customer list uses, so "any" means the same everywhere.
 *
 * "Any" widens which fields have to hold, never which rows the reader may
 * see: the refusals first, a technician and a branch manager asking for any
 * of two fields get only the rows their scope already shows them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("field-match-lists:org");
const OWNER = fixtureId("field-match-lists:owner");
const TECH = fixtureId("field-match-lists:tech");
const MANAGER = fixtureId("field-match-lists:manager");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
let tech: ServiceContext;
let manager: ServiceContext;

/** Four jobs: Austin North, Houston with a permit, Houston South, Austin with nothing. One invoice and estimate on each. */
const job: string[] = [];
const invoice: string[] = [];
const estimate: string[] = [];
const record: string[] = [];
const member: Record<string, string> = {};

async function person(userId: string, email: string, name: string, role: string, branch: string | null) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, ${role}::public.member_role, ${branch}) returning id`;
  return m!.id;
}

async function resolve(userId: string): Promise<ServiceContext> {
  const actor = await inTenant(owner(), (tx) => memberActor(tx, ORG, userId));
  if (!actor) throw new Error("No active membership.");
  return { actor, db: db() };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Field Match Co", slug: "field-match-lists-co" });
  const [austin] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [houston] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;

  await fields.define(owner(), { entityType: "job", key: "zone", label: "Zone", dataType: "select", options: ["North", "South"] });
  await fields.define(owner(), { entityType: "job", key: "permit", label: "Permit" });
  await fields.define(owner(), { entityType: "invoice", key: "po_ref", label: "PO reference" });
  await fields.define(owner(), { entityType: "invoice", key: "terms", label: "Terms", dataType: "select", options: ["30", "60"] });
  await fields.define(owner(), { entityType: "estimate", key: "source", label: "Source", dataType: "select", options: ["Web", "Phone"] });
  await fields.define(owner(), { entityType: "estimate", key: "urgent", label: "Urgent", dataType: "boolean" });
  await fields.define(owner(), { entityType: "technician", key: "van", label: "Van" });
  await fields.define(owner(), { entityType: "technician", key: "shift", label: "Shift", dataType: "select", options: ["Day", "Night"] });

  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Fay Match') returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Match Way', 'Austin', 'TX', '78701') returning id`;
  const shapes = [
    { branch: austin!.id, job: { zone: "North" }, invoice: { po_ref: "AC-1" }, estimate: { source: "Web" } },
    { branch: houston!.id, job: { permit: "P-77" }, invoice: { terms: "60" }, estimate: { urgent: true } },
    { branch: houston!.id, job: { zone: "South" }, invoice: {}, estimate: { source: "Phone" } },
    { branch: austin!.id, job: {}, invoice: {}, estimate: {} },
  ];
  for (const [index, shape] of shapes.entries()) {
    const n = 8401 + index;
    const [j] = await raw<{ id: string }[]>`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary, business_unit_id, custom_fields)
      values (${ORG}, ${n}, ${c!.id}, ${p!.id}, 'scheduled', ${`Job ${n}`}, ${shape.branch}, ${raw.json(shape.job)}) returning id`;
    const [i] = await raw<{ id: string }[]>`insert into public.invoice
      (organization_id, number, customer_id, job_id, status, issued_on, due_on, total, balance, custom_fields)
      values (${ORG}, ${n}, ${c!.id}, ${j!.id}, 'open', current_date, current_date, 100, 100, ${raw.json(shape.invoice)}) returning id`;
    const [e] = await raw<{ id: string }[]>`insert into public.estimate
      (organization_id, number, customer_id, property_id, job_id, title, custom_fields)
      values (${ORG}, ${n}, ${c!.id}, ${p!.id}, ${j!.id}, 'Options', ${raw.json(shape.estimate)}) returning id`;
    job.push(j!.id); invoice.push(i!.id); estimate.push(e!.id);
  }

  const techMembership = await person(TECH, "field-match-tech@test.local", "Tia Tech", "technician", austin!.id);
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, custom_fields)
    values (${ORG}, ${techMembership}, 'Tia Tech', ${raw.json({ van: "V-1" })}) returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status) values (${ORG}, ${job[0]!}, 'scheduled') returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${t!.id})`;
  member["tia"] = techMembership;
  const nightMembership = await person(fixtureId("field-match-lists:night"), "field-match-night@test.local", "Nell Night", "technician", houston!.id);
  await raw`insert into public.technician (organization_id, membership_id, display_name, custom_fields)
    values (${ORG}, ${nightMembership}, 'Nell Night', ${raw.json({ shift: "Night" })})`;
  member["nell"] = nightMembership;
  const plainMembership = await person(fixtureId("field-match-lists:plain"), "field-match-plain@test.local", "Pat Plain", "technician", houston!.id);
  await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${plainMembership}, 'Pat Plain')`;
  member["pat"] = plainMembership;
  await person(MANAGER, "field-match-manager@test.local", "Hana Houston", "branch_manager", houston!.id);

  await objects.defineKind(owner(), { key: "permit", label: "Permit", links: ["job"] });
  await fields.define(owner(), { entityType: "object:permit", key: "status", label: "Status", dataType: "select", options: ["submitted", "approved"] });
  await fields.define(owner(), { entityType: "object:permit", key: "city", label: "City" });
  for (const [index, values] of [{ status: "approved" }, { city: "Austin" }, {}].entries()) {
    record.push((await objects.createRecord(owner(), { type: "permit", title: `R-${index}`, jobId: job[index]!, customFields: values })).id);
  }

  tech = await resolve(TECH);
  manager = await resolve(MANAGER);
});

afterAll(async () => { if (raw) await raw.end(); });

const sorted = (ids: string[]) => [...ids].sort();
const jobIds = async (ctx: ServiceContext, input: { fields: string[]; fieldMatch?: "all" | "any" }) =>
  sorted((await jobs.list(ctx, { limit: 50, ...input })).data.map((j) => j.id));
const invoiceIds = async (ctx: ServiceContext, input: { fields: string[]; fieldMatch?: "all" | "any" }) =>
  sorted((await billing.list(ctx, { limit: 50, ...input })).data.map((i) => i.id));
const estimateIds = async (ctx: ServiceContext, input: { fields: string[]; fieldMatch?: "all" | "any" }) =>
  sorted((await estimates.list(ctx, { limit: 50, ...input })).data.map((e) => e.id));
const recordIds = async (ctx: ServiceContext, input: { fields: string[]; fieldMatch?: "all" | "any" }) =>
  sorted((await objects.listRecords(ctx, { type: "permit", ...input })).data.map((r) => r.id));
const memberIds = async (ctx: ServiceContext, input: { fields: string[]; fieldMatch?: "all" | "any" }) =>
  sorted((await people.listPeople(ctx, input)).map((p) => p.membershipId));

run("refusals: any of these never shows a row the reader's scope does not", () => {
  it("a technician asking for any of two fields gets only the work they were sent to", async () => {
    const both = { fields: ["zone:North", "permit:P-77"], fieldMatch: "any" as const };
    expect(await jobIds(tech, both)).toEqual([job[0]]);
    expect(await invoiceIds(tech, { fields: ["po_ref:AC", "terms:60"], fieldMatch: "any" })).toEqual([invoice[0]]);
    expect(await estimateIds(tech, { fields: ["source:Web", "urgent:yes"], fieldMatch: "any" })).toEqual([estimate[0]]);
    expect(await recordIds(tech, { fields: ["status:approved", "city:Austin"], fieldMatch: "any" })).toEqual([record[0]]);
  });

  it("a branch manager asking for any of two fields gets only their branch's", async () => {
    expect(await jobIds(manager, { fields: ["zone:North", "permit:P-77"], fieldMatch: "any" })).toEqual([job[1]]);
    expect(await invoiceIds(manager, { fields: ["po_ref:AC", "terms:60"], fieldMatch: "any" })).toEqual([invoice[1]]);
    expect(await estimateIds(manager, { fields: ["source:Web", "urgent:yes"], fieldMatch: "any" })).toEqual([estimate[1]]);
    expect(await memberIds(manager, { fields: ["van:V-1", "shift:Night"], fieldMatch: "any" })).toEqual([member["nell"]]);
  });

  it("a field nobody declared is refused in words whichever join is asked for", async () => {
    for (const fieldMatch of ["all", "any"] as const) {
      await expect(jobIds(owner(), { fields: ["zone:North", "colour:red"], fieldMatch })).rejects.toBeInstanceOf(ConflictError);
      await expect(memberIds(owner(), { fields: ["van:V-1", "colour:red"], fieldMatch })).rejects.toBeInstanceOf(ConflictError);
      await expect(recordIds(owner(), { fields: ["status:approved", "colour:red"], fieldMatch })).rejects.toBeInstanceOf(ConflictError);
    }
  });
});

run("any of these, as the owner", () => {
  it("joins a job's fields by or when asked, and by and otherwise", async () => {
    expect(await jobIds(owner(), { fields: ["zone:North", "permit:P-77"] })).toEqual([]);
    expect(await jobIds(owner(), { fields: ["zone:North", "permit:P-77"], fieldMatch: "all" })).toEqual([]);
    expect(await jobIds(owner(), { fields: ["zone:North", "permit:P-77"], fieldMatch: "any" })).toEqual(sorted([job[0]!, job[1]!]));
    expect(await jobIds(owner(), { fields: ["zone:North"], fieldMatch: "any" })).toEqual([job[0]]);
  });

  it("joins an invoice's, an estimate's, a technician's and a record's fields the same way", async () => {
    expect(await invoiceIds(owner(), { fields: ["po_ref:AC", "terms:60"] })).toEqual([]);
    expect(await invoiceIds(owner(), { fields: ["po_ref:AC", "terms:60"], fieldMatch: "any" })).toEqual(sorted([invoice[0]!, invoice[1]!]));
    expect(await estimateIds(owner(), { fields: ["source:Web", "urgent:yes"] })).toEqual([]);
    expect(await estimateIds(owner(), { fields: ["source:Web", "urgent:yes"], fieldMatch: "any" })).toEqual(sorted([estimate[0]!, estimate[1]!]));
    expect(await memberIds(owner(), { fields: ["van:V-1", "shift:Night"] })).toEqual([]);
    expect(await memberIds(owner(), { fields: ["van:V-1", "shift:Night"], fieldMatch: "any" })).toEqual(sorted([member["tia"]!, member["nell"]!]));
    expect(await recordIds(owner(), { fields: ["status:approved", "city:Austin"] })).toEqual([]);
    expect(await recordIds(owner(), { fields: ["status:approved", "city:Austin"], fieldMatch: "any" })).toEqual(sorted([record[0]!, record[1]!]));
  });

  it("is read off the query string over HTTP on each list, and refuses a word it does not know", async () => {
    const ask = (path: string) => dispatch(new Request(`http://x${path}`), { db: db(), resolveSession: async () => owner() });
    const ids = async (path: string, key: "data" | "people", id: "id" | "membershipId" = "id") => {
      const response = await ask(path);
      expect(response.status, path).toBe(200);
      return sorted(((await response.json()) as Record<string, Record<string, string>[]>)[key]!.map((row) => row[id]!));
    };
    expect(await ids("/v1/jobs?fields=zone%3ANorth&fields=permit%3AP-77&fieldMatch=any", "data")).toEqual(sorted([job[0]!, job[1]!]));
    expect(await ids("/v1/invoices?fields=po_ref%3AAC&fields=terms%3A60&fieldMatch=any", "data")).toEqual(sorted([invoice[0]!, invoice[1]!]));
    expect(await ids("/v1/estimates?fields=source%3AWeb&fields=urgent%3Ayes&fieldMatch=any", "data")).toEqual(sorted([estimate[0]!, estimate[1]!]));
    expect(await ids("/v1/people?fields=van%3AV-1&fields=shift%3ANight&fieldMatch=any", "people", "membershipId"))
      .toEqual(sorted([member["tia"]!, member["nell"]!]));
    expect(await ids("/v1/custom-records?type=permit&fields=status%3Aapproved&fields=city%3AAustin&fieldMatch=any", "data"))
      .toEqual(sorted([record[0]!, record[1]!]));
    for (const path of ["/v1/jobs", "/v1/invoices", "/v1/estimates", "/v1/people", "/v1/custom-records?type=permit&"]) {
      const joiner = path.endsWith("&") ? "" : "?";
      expect((await ask(`${path}${joiner}fields=zone%3ANorth&fieldMatch=either`)).status, path).toBe(422);
    }
  });
});
