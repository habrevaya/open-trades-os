import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as search from "../src/services/search";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import { memberActor } from "../src/services/session";
import { inTenant, type ServiceContext } from "../src/services/context";
import { routes } from "../src/contracts/index";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE SEARCH BOX NEVER FINDS WHAT ITS LISTS WOULD NOT SHOW
 *
 * One box searches customers, jobs, invoices, estimates, addresses and units.
 * Each of those is a list somebody is narrowed on: a technician sees the work
 * they were sent to, a branch manager their branch's. A box that searched the
 * tables instead of the lists would be the way round every one of those
 * narrowings, and the first thing a departing technician would type into it
 * is a street name.
 *
 * So these are written as refusals first: for each group, the hit outside
 * the person's scope is named and asserted absent, as the technician, as the
 * branch manager and as another company's owner. The owner's own search is
 * the control that proves each hit is there to be found.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("search-scope:org");
const OWNER = fixtureId("search-scope:owner");
const TECH = fixtureId("search-scope:tech");
const MANAGER = fixtureId("search-scope:manager");
const OTHER = fixtureId("search-scope:other-org");
const OTHER_OWNER = fixtureId("search-scope:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const otherOwner = (): ServiceContext => ({
  actor: { userId: OTHER_OWNER, organizationId: OTHER, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let tech: ServiceContext;
let manager: ServiceContext;

/** What one person's work is: a customer, their address, a job, an invoice, an estimate and a unit. */
interface Book { customer: string; property: string; job: string; jobNumber: number; invoice: string; invoiceNumber: number; estimate: string; estimateNumber: number; unit: string }
let ada: Book;
let bea: Book;
let beaSecondAddress = "";
let theirs: Book;

async function book(org: string, name: string, n: number, street: string, serial: string, summary: string, branch: string | null): Promise<Book> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${org}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${street}, 'Austin', 'TX', '78701') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary)
    values (${org}, ${c!.id}, ${p!.id}, true)`;
  const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${org}, ${n}, ${c!.id}, ${p!.id}, 'scheduled', ${summary}, ${branch}) returning id`;
  const [i] = await raw<{ id: string }[]>`insert into public.invoice
    (organization_id, number, customer_id, job_id, status, issued_on, due_on, total, balance)
    values (${org}, ${n + 500}, ${c!.id}, ${j!.id}, 'open', current_date, current_date, 100, 100) returning id`;
  const [e] = await raw<{ id: string }[]>`insert into public.estimate (organization_id, number, customer_id, property_id, job_id, title)
    values (${org}, ${n + 700}, ${c!.id}, ${p!.id}, ${j!.id}, ${`Replace the ${summary.toLowerCase()}`}) returning id`;
  const [u] = await raw<{ id: string }[]>`insert into public.equipment (organization_id, property_id, category, manufacturer, model, serial_number)
    values (${org}, ${p!.id}, 'Furnace', 'Zephyr', 'ZF-90', ${serial}) returning id`;
  return {
    customer: c!.id, property: p!.id, job: j!.id, jobNumber: n, invoice: i!.id, invoiceNumber: n + 500,
    estimate: e!.id, estimateNumber: n + 700, unit: u!.id,
  };
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

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Search Scope Co", slug: "search-scope-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_OWNER, name: "Search Neighbour Co", slug: "search-scope-neighbour" });

  const [austin] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [houston] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;

  ada = await book(ORG, "Ada Zephyr", 8101, "1 Zephyr Lane", "ZX-100", "Zephyr furnace noise", austin!.id);
  bea = await book(ORG, "Bea Zephyr", 8102, "2 Zephyr Lane", "ZX-200", "Zephyr boiler leak", houston!.id);
  const [second] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Zephyr Court', 'Austin', 'TX', '78702') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${bea.customer}, ${second!.id})`;
  beaSecondAddress = second!.id;
  theirs = await book(OTHER, "Cy Zephyr", 8103, "3 Zephyr Lane", "ZX-300", "Zephyr furnace noise", null);

  const techMembership = await person(ORG, TECH, "search-scope-tech@test.local", "Tia Tech", "technician", null);
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${techMembership}, 'Tia Tech') returning id`;
  /** The technician was sent to Ada's job, and only Ada's. */
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status) values (${ORG}, ${ada.job}, 'scheduled') returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${t!.id})`;
  await person(ORG, MANAGER, "search-scope-manager@test.local", "Hana Houston", "branch_manager", houston!.id);

  tech = await resolve(TECH);
  manager = await resolve(MANAGER);
});

afterAll(async () => { if (raw) await raw.end(); });

type Found = Awaited<ReturnType<typeof search.everything>>;
const hits = (found: Found, key: string): string[] => found.groups.find((g) => g.key === key)?.hits.map((h) => h.id) ?? [];
const everyId = (found: Found): string[] => found.groups.flatMap((g) => g.hits.map((h) => h.id));
const all = (b: Book) => [b.customer, b.property, b.job, b.invoice, b.estimate, b.unit];

run("refusals: nobody finds anything outside what their lists show", () => {
  it("a technician finds only the work they were sent to, in every group", async () => {
    const found = await search.everything(tech, { q: "zephyr" });
    expect(hits(found, "customers")).toEqual([ada.customer]);
    expect(hits(found, "jobs")).toEqual([ada.job]);
    expect(hits(found, "invoices")).toEqual([ada.invoice]);
    expect(hits(found, "estimates")).toEqual([ada.estimate]);
    expect(hits(found, "addresses")).toEqual([ada.property]);
    expect(hits(found, "units")).toEqual([ada.unit]);
    for (const id of [...all(bea), beaSecondAddress, ...all(theirs)]) expect(everyId(found)).not.toContain(id);
  });

  it("a technician does not find another job's documents by their numbers or another unit by its serial", async () => {
    for (const q of [String(bea.jobNumber), `#${bea.invoiceNumber}`, String(bea.estimateNumber), "ZX-200", "2 zephyr"]) {
      const found = await search.everything(tech, { q });
      for (const id of all(bea)) expect(everyId(found)).not.toContain(id);
    }
  });

  it("a branch manager finds only their branch's, in every group", async () => {
    const found = await search.everything(manager, { q: "zephyr" });
    expect(hits(found, "customers")).toEqual([bea.customer]);
    expect(hits(found, "jobs")).toEqual([bea.job]);
    expect(hits(found, "invoices")).toEqual([bea.invoice]);
    expect(hits(found, "estimates")).toEqual([bea.estimate]);
    expect(hits(found, "addresses")).toEqual([bea.property]);
    expect(hits(found, "units")).toEqual([bea.unit]);
    for (const id of [...all(ada), beaSecondAddress, ...all(theirs)]) expect(everyId(found)).not.toContain(id);
  });

  it("another company's owner finds none of this company's, by words or by numbers", async () => {
    for (const q of ["zephyr", "ZX-100", String(ada.jobNumber), String(ada.invoiceNumber), String(bea.estimateNumber)]) {
      const found = await search.everything(otherOwner(), { q });
      for (const id of [...all(ada), ...all(bea), beaSecondAddress]) expect(everyId(found)).not.toContain(id);
    }
    expect(hits(await search.everything(otherOwner(), { q: "zephyr" }), "jobs")).toEqual([theirs.job]);
  });

  it("the lists behind the see all links are narrowed the same way", async () => {
    expect((await jobs.list(tech, { q: "zephyr", limit: 50 })).data.map((j) => j.id)).toEqual([ada.job]);
    expect((await billing.list(manager, { q: "zephyr", limit: 50 })).data.map((i) => i.id)).toEqual([bea.invoice]);
    expect((await estimates.list(tech, { q: String(bea.estimateNumber), limit: 50 })).data).toEqual([]);
    expect((await search.everything(tech, { q: "zephyr", in: "addresses" })).groups.map((g) => g.key)).toEqual(["addresses"]);
  });
});

run("what the owner finds", () => {
  it("finds each group, five at most, with a link to the list filtered by the words", async () => {
    const found = await search.everything(owner(), { q: "zephyr" });
    routes.searchEverything.output.parse(found);
    expect(hits(found, "customers").sort()).toEqual([ada.customer, bea.customer].sort());
    expect(hits(found, "addresses").sort()).toEqual([ada.property, bea.property, beaSecondAddress].sort());
    expect(hits(found, "units").sort()).toEqual([ada.unit, bea.unit].sort());
    const jobsGroup = found.groups.find((g) => g.key === "jobs")!;
    expect(jobsGroup.seeAll).toBe("/jobs?q=zephyr");
    expect(found.groups.find((g) => g.key === "addresses")!.seeAll).toBe("/search?q=zephyr&in=addresses");
    for (const id of all(theirs)) expect(everyId(found)).not.toContain(id);
  });

  it("finds a job by words in its summary in any order, and by its customer's name", async () => {
    expect(hits(await search.everything(owner(), { q: "leak zephyr" }), "jobs")).toEqual([bea.job]);
    expect(hits(await search.everything(owner(), { q: "ada" }), "jobs")).toEqual([ada.job]);
  });

  it("finds an invoice and an estimate by number, with or without #, and by customer", async () => {
    expect(hits(await search.everything(owner(), { q: `#${ada.invoiceNumber}` }), "invoices")).toEqual([ada.invoice]);
    expect(hits(await search.everything(owner(), { q: String(bea.estimateNumber) }), "estimates")).toEqual([bea.estimate]);
    expect(hits(await search.everything(owner(), { q: "bea" }), "invoices")).toEqual([bea.invoice]);
  });

  it("finds an address by its street and a unit by its serial or its make and model", async () => {
    expect(hits(await search.everything(owner(), { q: "zephyr court" }), "addresses")).toEqual([beaSecondAddress]);
    expect(hits(await search.everything(owner(), { q: "zx-200" }), "units")).toEqual([bea.unit]);
    expect(hits(await search.everything(owner(), { q: "zephyr zf-90" }), "units").length).toBe(2);
  });

  it("takes % and _ as the characters they are", async () => {
    expect((await search.everything(owner(), { q: "%%" })).groups).toEqual([]);
    expect((await search.everything(owner(), { q: "__" })).groups).toEqual([]);
  });

  it("says when a group has more than the five it shows", async () => {
    for (let n = 0; n < 5; n += 1) {
      await raw`insert into public.customer (organization_id, name) values (${ORG}, ${`Extra Zephyr ${n}`})`;
    }
    const group = (await search.everything(owner(), { q: "zephyr" })).groups.find((g) => g.key === "customers")!;
    expect(group.hits).toHaveLength(5);
    expect(group.more).toBe(true);
    expect(group.seeAll).toBe("/customers?q=zephyr");
  });
});
