import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as search from "../src/services/search";
import * as pricebook from "../src/services/pricebook";
import { memberActor } from "../src/services/session";
import { inTenant, type ServiceContext } from "../src/services/context";
import { routes } from "../src/contracts/index";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE SEARCH BOX FORGIVES A TYPO, AND FINDS NOTES, PRICES AND PEOPLE
 *
 * "furnice" finds the furnace job: after every exact match, and marked as
 * close, through the same lists with the same scope, so a technician's typo
 * finds nothing their spelling would not have. A number is never guessed at.
 *
 * A customer's notes, the price book and the company's people are groups of
 * their own, each behind the permission that reads it, the notes through the
 * customer's scope and only those marked for the field at a technician's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("search-close:org");
const OWNER = fixtureId("search-close:owner");
const TECH = fixtureId("search-close:tech");
const MANAGER = fixtureId("search-close:manager");
const OTHER = fixtureId("search-close:other-org");
const OTHER_OWNER = fixtureId("search-close:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (over: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"], ...over }, db: db(),
});
const otherOwner = (): ServiceContext => ({
  actor: { userId: OTHER_OWNER, organizationId: OTHER, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let tech: ServiceContext;
let manager: ServiceContext;

interface Work { customer: string; job: string }
let ada: Work;
let bea: Work;
let exactJob = "";
let theirs: Work;
const notes: Record<string, string> = {};
let thermostat = "";
let houstonPerson = "";
let austinPerson = "";

async function work(org: string, name: string, n: number, summary: string, branch: string | null): Promise<Work> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${org}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${`${n} Birch Road`}, 'Austin', 'TX', '78701') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary)
    values (${org}, ${c!.id}, ${p!.id}, true)`;
  const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${org}, ${n}, ${c!.id}, ${p!.id}, 'scheduled', ${summary}, ${branch}) returning id`;
  return { customer: c!.id, job: j!.id };
}

async function note(org: string, customerId: string, body: string, forField: boolean) {
  const [row] = await raw<{ id: string }[]>`insert into public.customer_note (organization_id, customer_id, body, for_field)
    values (${org}, ${customerId}, ${body}, ${forField}) returning id`;
  return row!.id;
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
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Search Close Co", slug: "search-close-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_OWNER, name: "Search Close Neighbour", slug: "search-close-neighbour" });
  const [austin] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [houston] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;

  ada = await work(ORG, "Ada Lindqvist", 4101, "Annual furnace tune up", austin!.id);
  bea = await work(ORG, "Bea Lindqvist", 4102, "Furnace leaking water", houston!.id);
  exactJob = (await work(ORG, "Cal Lindqvist", 4103, "Furnice brand boiler check", austin!.id)).job;
  theirs = await work(OTHER, "Cy Lindqvist", 4104, "Furnace not lighting", null);

  notes["adaField"] = await note(ORG, ada.customer, "Side gate code is 4471, thermostat in the hall closet.", true);
  notes["adaOffice"] = await note(ORG, ada.customer, "Disputed the last thermostat bill, be careful on price.", false);
  notes["bea"] = await note(ORG, bea.customer, "Thermostat wiring is old, ask before touching it.", true);
  notes["theirs"] = await note(OTHER, theirs.customer, "Thermostat on the landing.", true);

  thermostat = (await pricebook.create(owner(), {
    kind: "material", code: "TSTAT-7", name: "Smart thermostat", price: "189.00",
  } as Parameters<typeof pricebook.create>[1])).id as string;

  const techMembership = await person(ORG, TECH, "search-close-tech@test.local", "Tia Tech", "technician", null);
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${techMembership}, 'Tia Tech') returning id`;
  /** The technician was sent to Ada's job, and only Ada's. */
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status) values (${ORG}, ${ada.job}, 'scheduled') returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${t!.id})`;
  await person(ORG, MANAGER, "search-close-manager@test.local", "Hana Houston", "branch_manager", houston!.id);
  houstonPerson = await person(ORG, fixtureId("search-close:rosalind"), "search-close-rosalind@test.local",
    "Rosalind Okonkwo", "csr", houston!.id);
  austinPerson = await person(ORG, fixtureId("search-close:rosalyn"), "search-close-rosalyn@test.local",
    "Rosalyn Okonkwo", "csr", austin!.id);

  tech = await resolve(TECH);
  manager = await resolve(MANAGER);
});

afterAll(async () => { if (raw) await raw.end(); });

type Found = Awaited<ReturnType<typeof search.everything>>;
const group = (found: Found, key: string) => found.groups.find((g) => g.key === key);
const hits = (found: Found, key: string) => group(found, key)?.hits.map((h) => ({ id: h.id, close: h.close })) ?? [];
const everyId = (found: Found): string[] => found.groups.flatMap((g) => g.hits.map((h) => h.id));

run("a typo is forgiven, after what was typed", () => {
  it("finds the furnace jobs by furnice, after the job that says furnice, marked as close", async () => {
    const found = await search.everything(owner(), { q: "furnice" });
    routes.searchEverything.output.parse(found);
    const jobs = hits(found, "jobs");
    expect(jobs[0]).toEqual({ id: exactJob, close: false });
    expect(jobs.slice(1).map((h) => h.close)).toEqual([true, true]);
    expect(jobs.slice(1).map((h) => h.id).sort()).toEqual([ada.job, bea.job].sort());
    expect(everyId(found)).not.toContain(theirs.job);
    // The list behind See all is the exact matches, so `more` counts only those.
    expect(group(found, "jobs")!.more).toBe(false);
  });

  it("takes each word as typed or a letter off, in any order", async () => {
    expect(hits(await search.everything(owner(), { q: "lindqvist furnase" }), "jobs").map((h) => h.id))
      .toEqual(expect.arrayContaining([ada.job, bea.job]));
    expect(hits(await search.everything(owner(), { q: "furnace leeking" }), "jobs")).toEqual([{ id: bea.job, close: true }]);
  });

  it("never guesses at a number, or at a word too far off", async () => {
    expect(hits(await search.everything(owner(), { q: "4109" }), "jobs")).toEqual([]);
    expect(hits(await search.everything(owner(), { q: "fornoce" }), "jobs")).toEqual([]);
    expect(hits(await search.everything(owner(), { q: "boyl" }), "jobs")).toEqual([]);
  });

  it("finds nothing close that the reader's lists would not show", async () => {
    expect(hits(await search.everything(tech, { q: "furnice" }), "jobs")).toEqual([{ id: ada.job, close: true }]);
    expect(hits(await search.everything(manager, { q: "furnice" }), "jobs")).toEqual([{ id: bea.job, close: true }]);
    const neighbour = await search.everything(otherOwner(), { q: "furnice" });
    expect(hits(neighbour, "jobs")).toEqual([{ id: theirs.job, close: true }]);
    for (const id of [ada.job, bea.job, exactJob]) expect(everyId(neighbour)).not.toContain(id);
  });
});

run("customer notes, the price book and people", () => {
  it("finds a customer's notes by what they say, typo or not, linking to the customer", async () => {
    const found = await search.everything(owner(), { q: "thermstat" });
    const noted = group(found, "notes")!;
    expect(noted.hits.map((h) => h.id).sort()).toEqual([notes["adaField"], notes["adaOffice"], notes["bea"]].sort());
    expect(noted.hits.every((h) => h.close)).toBe(true);
    expect(noted.hits.find((h) => h.id === notes["bea"])!.href).toBe(`/customers/${bea.customer}`);
    expect(everyId(found)).not.toContain(notes["theirs"]);
    expect(hits(await search.everything(owner(), { q: "gate code" }), "notes")).toEqual([{ id: notes["adaField"], close: false }]);
  });

  it("gives a technician only the field notes of customers they were sent to", async () => {
    expect(hits(await search.everything(tech, { q: "thermostat" }), "notes")).toEqual([{ id: notes["adaField"], close: false }]);
    expect(hits(await search.everything(manager, { q: "thermostat" }), "notes")).toEqual([{ id: notes["bea"], close: false }]);
    expect(group(await search.everything(owner({ revocations: ["customer:read"] }), { q: "thermostat" }), "notes"))
      .toBeUndefined();
  });

  it("finds a price book item by its name, its code or a letter off, behind pricebook:read", async () => {
    expect(hits(await search.everything(owner(), { q: "tstat-7" }), "pricebook")).toEqual([{ id: thermostat, close: false }]);
    expect(hits(await search.everything(owner(), { q: "smart thermstat" }), "pricebook")).toEqual([{ id: thermostat, close: true }]);
    expect(group(await search.everything(owner(), { q: "thermostat" }), "pricebook")!.seeAll).toBe("/pricebook?q=thermostat");
    expect(group(await search.everything(owner({ revocations: ["pricebook:read"] }), { q: "thermostat" }), "pricebook"))
      .toBeUndefined();
  });

  it("finds people by name behind user:read, a branch manager only their branch's", async () => {
    const found = await search.everything(owner(), { q: "okonkwo" });
    expect(hits(found, "people").map((h) => h.id).sort()).toEqual([houstonPerson, austinPerson].sort());
    expect(group(found, "people")!.hits[0]!.href).toMatch(/^\/people\//);
    expect(hits(await search.everything(owner(), { q: "rosalind" }), "people")).toEqual([
      { id: houstonPerson, close: false }, { id: austinPerson, close: true },
    ]);
    expect(hits(await search.everything(manager, { q: "okonkwo" }), "people")).toEqual([{ id: houstonPerson, close: false }]);
    expect(group(await search.everything(tech, { q: "okonkwo" }), "people")).toBeUndefined();
    expect(group(await search.everything(otherOwner(), { q: "okonkwo" }), "people")).toBeUndefined();
  });

  it("shows one group alone at up to fifty", async () => {
    const alone = await search.everything(owner(), { q: "thermostat", in: "notes" });
    expect(alone.groups.map((g) => g.key)).toEqual(["notes"]);
    expect(alone.groups[0]!.seeAll).toBeNull();
  });
});
