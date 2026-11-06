import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { memberActor } from "../src/services/session";
import { inTenant, type ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { routes } from "../src/contracts/index";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A VISIT FOUND BY WHO IS ON IT (M29)
 *
 * "Which of Ray's visits was the Hill job?" The search box found a visit by its
 * notes, its job and its customer, and not by the technician sent or the crew it
 * was booked to. Now it does, through the same visit scope as everything else:
 * a branch manager naming another branch's technician finds nothing, and a
 * technician naming a colleague finds none of the colleague's visits.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("search-people:org");
const OWNER = fixtureId("search-people:owner");
const RAY = fixtureId("search-people:ray");
const HANK = fixtureId("search-people:hank");
const MANAGER = fixtureId("search-people:manager");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
let ray: ServiceContext;
let manager: ServiceContext;

let austinVisit = "";
let houstonVisit = "";
let crewVisit = "";

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

async function visitOn(n: number, summary: string, branch: string): Promise<string> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, ${`Customer ${n}`}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${`${n} Main St`}, 'Austin', 'TX', '78701') returning id`;
  const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary, business_unit_id)
    values (${ORG}, ${n}, ${c!.id}, ${p!.id}, 'scheduled', ${summary}, ${branch}) returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status) values (${ORG}, ${j!.id}, 'scheduled') returning id`;
  return v!.id;
}

async function find(ctx: ServiceContext, q: string): Promise<{ id: string; detail: string | null }[]> {
  const response = await dispatch(new Request(`http://x/v1/search?q=${encodeURIComponent(q)}&in=visits`), {
    db: db(), resolveSession: async () => ctx,
  });
  expect(response.status).toBe(200);
  const body = routes.searchEverything.output.parse(await response.json());
  return body.groups.find((g) => g.key === "visits")?.hits.map((h) => ({ id: h.id, detail: h.detail })) ?? [];
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Search People Co", slug: "search-visit-people-co" });
  const [austin] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  const [houston] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;

  const rayMembership = await person(RAY, "search-people-ray@test.local", "Ray Fielding", "technician", null);
  const hankMembership = await person(HANK, "search-people-hank@test.local", "Hank Quill", "technician", null);
  await person(MANAGER, "search-people-manager@test.local", "Hana Houston", "branch_manager", houston!.id);
  const [rayTech] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${rayMembership}, 'Ray Fielding') returning id`;
  const [hankTech] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${hankMembership}, 'Hank Quill') returning id`;

  austinVisit = await visitOn(9101, "Furnace tune up", austin!.id);
  houstonVisit = await visitOn(9102, "Boiler leak", houston!.id);
  crewVisit = await visitOn(9103, "Roof tear off", houston!.id);
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${austinVisit}, ${rayTech!.id}, true)`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead) values (${ORG}, ${houstonVisit}, ${hankTech!.id}, true)`;
  const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Shingle Squad') returning id`;
  await raw`update public.visit set crew_id = ${crew!.id} where id = ${crewVisit}`;

  ray = await resolve(RAY);
  manager = await resolve(MANAGER);
});

afterAll(async () => { if (raw) await raw.end(); });

run("visits found by who is on them", () => {
  it("finds a visit by its technician's name, and says who is on it", async () => {
    const found = await find(owner(), "Fielding");
    expect(found.map((h) => h.id)).toEqual([austinVisit]);
    expect(found[0]!.detail).toContain("with Ray Fielding");
  });

  it("finds a visit by its crew's name", async () => {
    const found = await find(owner(), "shingle");
    expect(found.map((h) => h.id)).toEqual([crewVisit]);
    expect(found[0]!.detail).toContain("crew Shingle Squad");
  });

  it("forgives a letter off a technician's name, as the box does everywhere", async () => {
    expect((await find(owner(), "Feilding")).map((h) => h.id)).toEqual([austinVisit]);
  });

  it("keeps to the reader's scope: another branch's technician, a colleague's visits", async () => {
    // The Houston manager sees Houston's visits by name, and none of Austin's.
    expect(await find(manager, "Fielding")).toEqual([]);
    expect((await find(manager, "Quill")).map((h) => h.id)).toEqual([houstonVisit]);
    // Ray finds his own visit by his own name and none of Hank's by Hank's.
    expect((await find(ray, "Fielding")).map((h) => h.id)).toEqual([austinVisit]);
    expect(await find(ray, "Quill")).toEqual([]);
  });
});
