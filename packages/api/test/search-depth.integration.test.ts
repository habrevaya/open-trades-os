import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as search from "../src/services/search";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as objects from "../src/services/custom-objects";
import * as customFields from "../src/services/custom-fields";
import { memberActor } from "../src/services/session";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * SEARCH LOOKS IN WHAT WAS WRITTEN, AND STILL ONLY WHERE THE READER MAY LOOK
 *
 * The search box and the job, invoice and estimate lists now match a job's
 * description, the customer's words and its visits' notes, an invoice's memo
 * and lines, and an estimate's options and lines; a kind of record's list
 * matches word by word in its name and values. Every one of those is a place
 * a word can be that is not on the row being listed, which is exactly the
 * shape of a leak: a subquery that forgot whose rows it was reading would let
 * a technician find a job by a word in a note on somebody else's.
 *
 * So the refusals come first, and each word below is written in ONE place
 * only, on one person's work, so a hit can only have come from that place:
 * a technician, a branch manager outside the branch and another company's
 * owner type each of Bea's words and find nothing of Bea's, and type the
 * neighbour's words and find nothing at all. The owner's search, after them,
 * is the control that proves each word is there to be found.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("search-depth:org");
const OWNER = fixtureId("search-depth:owner");
const TECH = fixtureId("search-depth:tech");
const MANAGER = fixtureId("search-depth:manager");
const OTHER = fixtureId("search-depth:other-org");
const OTHER_OWNER = fixtureId("search-depth:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const otherOwner = (): ServiceContext => ({
  actor: { userId: OTHER_OWNER, organizationId: OTHER, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let tech: ServiceContext;
let manager: ServiceContext;

/**
 * The word written in each place on one person's work. Every word is made
 * up, and each is written once, so a hit names the place it came from.
 */
interface Words {
  description: string; complaint: string; technicianNotes: string; customerNotes: string;
  memo: string; lineName: string; lineDescription: string;
  optionName: string; optionDescription: string; estimateLineName: string; estimateLineDescription: string;
}
const wordsFor = (stem: string): Words => ({
  description: `${stem}desc`, complaint: `${stem}complaint`, technicianNotes: `${stem}technote`,
  customerNotes: `${stem}custnote`, memo: `${stem}memo`, lineName: `${stem}linename`,
  lineDescription: `${stem}linedesc`, optionName: `${stem}optname`, optionDescription: `${stem}optdesc`,
  estimateLineName: `${stem}estline`, estimateLineDescription: `${stem}estlinedesc`,
});

interface Work { customer: string; job: string; visit: string; invoice: string; estimate: string; words: Words }
let ada: Work;
let bea: Work;
let theirs: Work;

async function work(org: string, name: string, n: number, branch: string | null, words: Words): Promise<Work> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${org}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${`${n} Plain Street`}, 'Austin', 'TX', '78701') returning id`;
  const [j] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary, description, customer_complaint, business_unit_id)
    values (${org}, ${n}, ${c!.id}, ${p!.id}, 'scheduled', 'Service call',
      ${`Check the unit, ${words.description} reported`}, ${`It makes a ${words.complaint} sound`}, ${branch})
    returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, technician_notes, customer_notes)
    values (${org}, ${j!.id}, 'scheduled', ${`Flue ${words.technicianNotes} found`}, ${`We saw ${words.customerNotes} today`})
    returning id`;
  const [i] = await raw<{ id: string }[]>`insert into public.invoice
    (organization_id, number, customer_id, job_id, status, issued_on, due_on, total, balance, memo)
    values (${org}, ${n + 500}, ${c!.id}, ${j!.id}, 'open', current_date, current_date, 100, 100, ${`Thanks, ${words.memo}`})
    returning id`;
  await raw`insert into public.invoice_line (organization_id, invoice_id, name, description, quantity, unit_price, line_total)
    values (${org}, ${i!.id}, ${`Valve ${words.lineName}`}, ${`Fitted a ${words.lineDescription} part`}, 1, 100, 100)`;
  const [e] = await raw<{ id: string }[]>`insert into public.estimate (organization_id, number, customer_id, property_id, job_id, title)
    values (${org}, ${n + 700}, ${c!.id}, ${p!.id}, ${j!.id}, 'Options for the unit') returning id`;
  const [o] = await raw<{ id: string }[]>`insert into public.estimate_option (organization_id, estimate_id, name, description)
    values (${org}, ${e!.id}, ${`Best ${words.optionName}`}, ${`Includes ${words.optionDescription}`}) returning id`;
  await raw`insert into public.estimate_line (organization_id, option_id, name, description)
    values (${org}, ${o!.id}, ${`Coil ${words.estimateLineName}`}, ${`A ${words.estimateLineDescription} coil`})`;
  return { customer: c!.id, job: j!.id, visit: v!.id, invoice: i!.id, estimate: e!.id, words };
}

async function person(org: string, userId: string, email: string, name: string, role: string, branch: string | null) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${org}, ${userId}, ${role}::public.member_role, ${branch}) returning id`;
  return m!.id;
}

async function resolve(userId: string): Promise<ServiceContext> {
  const actor = await inTenant(owner(), (tx) => memberActor(tx, ORG, userId));
  if (!actor) throw new Error("No active membership.");
  return { actor, db: db() };
}

/** Records of the company's own kind, one on each person's job, each with a word only it holds. */
let adaPermit = "";
let beaPermit = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Search Depth Co", slug: "search-depth-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_OWNER, name: "Search Depth Neighbour", slug: "search-depth-neighbour" });

  const [austin] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [houston] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;

  ada = await work(ORG, "Ada Quill", 8301, austin!.id, wordsFor("amber"));
  bea = await work(ORG, "Bea Quill", 8302, houston!.id, wordsFor("basalt"));
  theirs = await work(OTHER, "Cy Quill", 8303, null, wordsFor("cobalt"));

  const techMembership = await person(ORG, TECH, "search-depth-tech@test.local", "Tia Tech", "technician", null);
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${techMembership}, 'Tia Tech') returning id`;
  /** The technician was sent to Ada's job, and only Ada's. */
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${ada.visit}, ${t!.id})`;
  await person(ORG, MANAGER, "search-depth-manager@test.local", "Hana Houston", "branch_manager", houston!.id);

  await objects.defineKind(owner(), { key: "permit", label: "Permit", titleLabel: "Permit number", links: ["customer", "job"] });
  await customFields.define(owner(), { entityType: "object:permit", key: "street", label: "Street" });
  await customFields.define(owner(), { entityType: "object:permit", key: "inspector", label: "Inspector" });
  adaPermit = (await objects.createRecord(owner(), {
    type: "permit", title: "AP-1", jobId: ada.job, customFields: { street: "Elm Road", inspector: "Ostrander" },
  })).id;
  beaPermit = (await objects.createRecord(owner(), {
    type: "permit", title: "BP-1", jobId: bea.job, customFields: { street: "Oak Road", inspector: "basaltinspector" },
  })).id;

  tech = await resolve(TECH);
  manager = await resolve(MANAGER);
});

afterAll(async () => { if (raw) await raw.end(); });

type Found = Awaited<ReturnType<typeof search.everything>>;
const hits = (found: Found, key: string): string[] => found.groups.find((g) => g.key === key)?.hits.map((h) => h.id) ?? [];
const everyId = (found: Found): string[] => found.groups.flatMap((g) => g.hits.map((h) => h.id));
const ids = (w: Work) => [w.customer, w.job, w.invoice, w.estimate];
const each = (w: Work) => Object.values(w.words);

/** What each list behind the box finds for a word, as one list of ids. */
async function listed(ctx: ServiceContext, q: string): Promise<string[]> {
  const found: string[] = [];
  found.push(...(await jobs.list(ctx, { q, limit: 50 })).data.map((j) => j.id));
  found.push(...(await billing.list(ctx, { q, limit: 50 })).data.map((i) => i.id));
  found.push(...(await estimates.list(ctx, { q, limit: 50 })).data.map((e) => e.id));
  found.push(...(await objects.listRecords(ctx, { type: "permit", q, limit: 50 })).data.map((r) => r.id));
  return found;
}

run("refusals: words written on work somebody may not open find nothing", () => {
  it("a technician finds nothing of another job by a word only in its notes, lines or options", async () => {
    for (const q of [...each(bea), "basaltinspector"]) {
      const found = await search.everything(tech, { q });
      for (const id of [...ids(bea), beaPermit]) expect(everyId(found)).not.toContain(id);
      expect(await listed(tech, q)).toEqual([]);
    }
  });

  it("a branch manager finds nothing of another branch's work by a word only in its notes, lines or options", async () => {
    for (const q of [...each(ada), "ostrander"]) {
      const found = await search.everything(manager, { q });
      for (const id of [...ids(ada), adaPermit]) expect(everyId(found)).not.toContain(id);
      expect(await listed(manager, q)).toEqual([]);
    }
  });

  it("another company's owner finds none of this company's work by any of its words", async () => {
    for (const q of [...each(ada), ...each(bea), "ostrander", "basaltinspector"]) {
      const found = await search.everything(otherOwner(), { q });
      expect(found.groups).toEqual([]);
    }
  });

  it("nobody here finds anything by words only in another company's notes, lines or options", async () => {
    for (const ctx of [owner(), tech, manager]) {
      for (const q of each(theirs)) {
        expect((await search.everything(ctx, { q })).groups).toEqual([]);
        expect(await listed(ctx, q)).toEqual([]);
      }
    }
  });

  it("a word on the reader's own work and a word on somebody else's together find nothing", async () => {
    const q = `${ada.words.technicianNotes} ${bea.words.memo}`;
    expect((await search.everything(tech, { q })).groups).toEqual([]);
    expect((await search.everything(owner(), { q })).groups).toEqual([]);
  });
});

run("where a word is found", () => {
  it("finds a job by its description, the customer's words and either note on a visit", async () => {
    for (const word of [ada.words.description, ada.words.complaint, ada.words.technicianNotes, ada.words.customerNotes]) {
      expect(hits(await search.everything(owner(), { q: word }), "jobs")).toEqual([ada.job]);
    }
  });

  it("finds an invoice by its memo, a line's name and a line's description", async () => {
    for (const word of [ada.words.memo, ada.words.lineName, ada.words.lineDescription]) {
      expect(hits(await search.everything(owner(), { q: word }), "invoices")).toEqual([ada.invoice]);
    }
  });

  it("finds an estimate by an option's name or description and a line's name or description", async () => {
    for (const word of [ada.words.optionName, ada.words.optionDescription, ada.words.estimateLineName, ada.words.estimateLineDescription]) {
      expect(hits(await search.everything(owner(), { q: word }), "estimates")).toEqual([ada.estimate]);
    }
  });

  it("takes each word from wherever it is: the customer's name and a technician's note together", async () => {
    expect((await jobs.list(owner(), { q: `${ada.words.technicianNotes} quill`, limit: 50 })).data.map((j) => j.id))
      .toEqual([ada.job]);
    expect((await billing.list(owner(), { q: `ada ${ada.words.lineName}`, limit: 50 })).data.map((i) => i.id))
      .toEqual([ada.invoice]);
    expect((await estimates.list(owner(), { q: `${ada.words.optionName} ${ada.words.estimateLineDescription}`, limit: 50 }))
      .data.map((e) => e.id)).toEqual([ada.estimate]);
  });

  it("a technician finds the work they were sent to by what was written on it", async () => {
    expect(hits(await search.everything(tech, { q: ada.words.technicianNotes }), "jobs")).toEqual([ada.job]);
    expect(hits(await search.everything(tech, { q: ada.words.lineDescription }), "invoices")).toEqual([ada.invoice]);
    expect(hits(await search.everything(tech, { q: ada.words.optionName }), "estimates")).toEqual([ada.estimate]);
  });

  it("a branch manager finds their branch's work by what was written on it", async () => {
    expect(hits(await search.everything(manager, { q: bea.words.customerNotes }), "jobs")).toEqual([bea.job]);
    expect(hits(await search.everything(manager, { q: bea.words.memo }), "invoices")).toEqual([bea.invoice]);
  });
});

run("a kind of record's list reads words like the others", () => {
  it("matches each word in the name or any value, in any order", async () => {
    const found = async (q: string) => (await objects.listRecords(owner(), { type: "permit", q })).data.map((r) => r.id);
    expect(await found("elm ostrander")).toEqual([adaPermit]);
    expect(await found("ostrander elm")).toEqual([adaPermit]);
    expect(await found("ap-1 elm")).toEqual([adaPermit]);
    expect(await found("elm basaltinspector")).toEqual([]);
    expect((await found("road")).sort()).toEqual([adaPermit, beaPermit].sort());
  });

  it("matches values and not the keys they are stored under", async () => {
    expect((await objects.listRecords(owner(), { type: "permit", q: "inspector" })).data.map((r) => r.id)).toEqual([beaPermit]);
    expect((await objects.listRecords(owner(), { type: "permit", q: "street" })).data).toEqual([]);
  });

  it("the search box finds a record by two words in two of its values", async () => {
    expect(hits(await search.everything(owner(), { q: "elm ostrander" }), "record:permit")).toEqual([adaPermit]);
    expect(hits(await search.everything(tech, { q: "elm ostrander" }), "record:permit")).toEqual([adaPermit]);
    expect(hits(await search.everything(tech, { q: "oak road" }), "record:permit")).toEqual([]);
  });
});
