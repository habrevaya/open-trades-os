import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as notes from "../src/services/customer-notes";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as company from "../src/services/company";
import * as search from "../src/services/search";
import type { ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { routes } from "../src/contracts/index";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CUSTOMER LIST SAYS WHEN IT WAS A NOTE THAT MATCHED (M03)
 *
 * "gate code" listed the account whose note said it, with nothing on the row
 * to say why. The row now carries the note's few words when nothing else on it
 * says what was typed, and only a note the person could read anyway: a
 * technician sees a field note's words and never an office note's, and a
 * customer outside a branch manager's branch is not on their list at all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("note-match:org");
const OWNER = fixtureId("note-match:owner");
const HANA = fixtureId("note-match:hana");
const RAY = fixtureId("note-match:ray");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db() });
let austin = "";
let houston = "";
let rayTech = "";
const houstonManager = (): ServiceContext => ({
  actor: { userId: HANA, organizationId: ORG, roles: ["branch_manager"], businessUnitId: houston }, db: db(),
});
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"] as Actor["roles"], technicianId: rayTech }, db: db(),
});

let gate = "";
let quill = "";
let office = "";

type Row = { id: string; name: string; matchedNote?: { id: string; excerpt: string } | null };
async function listed(ctx: ServiceContext, q: string): Promise<Row[]> {
  const response = await dispatch(new Request(`http://x/v1/customers?q=${encodeURIComponent(q)}`), {
    db: db(), resolveSession: async () => ctx,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  routes.listCustomers.output.parse(body);
  return (body as { data: Row[] }).data;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Note Match Co", slug: "customer-note-match-co" });
  for (const [id, email, role] of [[HANA, "note-match-hana@test.local", "office_manager"], [RAY, "note-match-ray@test.local", "technician"]] as const) {
    await raw`delete from public."user" where id = ${id} or email = ${email}`;
    await raw`insert into public."user" (id, email) values (${id}, ${email})`;
    const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::public.member_role) returning id`;
    if (id === RAY) {
      const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, 'Ray Field') returning id`;
      rayTech = t!.id;
    }
  }
  austin = (await company.createBusinessUnit(owner(), { name: "Austin", code: "AUS" })).id;
  houston = (await company.createBusinessUnit(owner(), { name: "Houston", code: "HOU" })).id;

  const customer = async (name: string, branch: string) => {
    const id = (await customers.create(owner(), {
      type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    })).id as string;
    const place = (await properties.create(owner(), {
      address: { line1: `${name} St`, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: id, customerRole: "owner",
    })).id as string;
    const job = (await jobs.create(owner(), {
      customerId: id, propertyId: place, summary: "Service", tags: [], customFields: {}, businessUnitId: branch,
    })).id as string;
    return { id, job };
  };
  const g = await customer("Greta Lindqvist", austin);
  gate = g.id;
  quill = (await customer("Quill Pennington", houston)).id;
  office = (await customer("Odette Marsh", austin)).id;

  await notes.add(owner(), { id: gate, body: `${"Rings twice before coming round the back. ".repeat(4)}The gate code is 4471 and the dog is friendly.`, forField: true });
  await notes.add(owner(), { id: quill, body: "Gate code 9902, the side gate sticks.", forField: true });
  await notes.add(owner(), { id: office, body: "Disputed the March invoice; the gatekeeper is her son.", forField: false });

  /** Ray was sent to Greta's and Odette's jobs. */
  for (const jobOf of [g.job, (await raw<{ id: string }[]>`select id from public.job where customer_id = ${office}`)[0]!.id]) {
    const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, sequence, status) values (${ORG}, ${jobOf}, 1, 'scheduled') returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${v!.id}, ${rayTech}, true)`;
  }
});

afterAll(async () => { if (raw) await raw.end(); });

run("a customer found by a note", () => {
  it("carries the note's words around the word typed, when nothing else on the row says it", async () => {
    const rows = await listed(owner(), "4471");
    expect(rows.map((r) => r.id)).toEqual([gate]);
    expect(rows[0]!.matchedNote!.excerpt).toContain("gate code is 4471");
    expect(rows[0]!.matchedNote!.excerpt.startsWith("...")).toBe(true);
  });

  it("carries nothing when the row explains itself, or when the list was not searched", async () => {
    const byName = await listed(owner(), "Pennington");
    expect(byName.map((r) => [r.id, r.matchedNote])).toEqual([[quill, null]]);
    const all = await listed(owner(), "");
    expect(all.every((r) => r.matchedNote === null)).toBe(true);
  });

  it("finds the note that says the word when the name says the other", async () => {
    // "greta" is her name, "dog" is only in her note.
    const rows = await listed(owner(), "greta dog");
    expect(rows.map((r) => r.id)).toEqual([gate]);
    expect(rows[0]!.matchedNote!.excerpt).toContain("dog is friendly");
  });

  it("shows a technician a field note's words and never an office note's", async () => {
    // Odette is on Ray's list, but her only note is the office's, so "gatekeeper" does not find her for him.
    expect((await listed(ray(), "gatekeeper")).map((r) => r.id)).toEqual([]);
    const theirs = await listed(ray(), "gate");
    expect(theirs.map((r) => r.id)).toEqual([gate]);
    expect(theirs[0]!.matchedNote!.excerpt).toContain("gate code");
    // The owner reads both.
    const mine = await listed(owner(), "gatekeeper");
    expect(mine.map((r) => r.id)).toEqual([office]);
    expect(mine[0]!.matchedNote!.excerpt).toContain("gatekeeper is her son");
  });

  it("keeps a branch manager to their branch's customers and those customers' notes", async () => {
    const rows = await listed(houstonManager(), "gate");
    expect(rows.map((r) => r.id)).toEqual([quill]);
    expect(rows[0]!.matchedNote!.excerpt).toContain("Gate code 9902");
  });

  it("says it in the search box too", async () => {
    const found = await search.everything(owner(), { q: "4471", in: "customers" });
    const hit = found.groups.find((g) => g.key === "customers")!.hits[0]!;
    expect(hit.detail).toMatch(/^From a note: .*gate code is 4471/);
  });
});
