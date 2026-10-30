import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as rules from "../src/services/task-rules";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * LOOPS ALREADY IN WHO ANSWERS TO WHOM
 *
 * A line that would close a loop is refused when saved. A loop that was
 * already in the data (lines from before that check, written here straight
 * into the table the way they would have been) is found, named in words with
 * the people in it, and left exactly as it is: the scan reads and never mends.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rloops:org");
const OWNER = fixtureId("rloops:owner");
const ANA = fixtureId("rloops:ana");
const BEN = fixtureId("rloops:ben");
const CY = fixtureId("rloops:cy");
const DEE = fixtureId("rloops:dee");
const TECH = fixtureId("rloops:tech");
const PEOPLE = [ANA, BEN, CY, DEE, TECH];

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);

const reportsTo = (userId: string, managerId: string | null) =>
  raw`update public.membership set reports_to_user_id = ${managerId} where organization_id = ${ORG} and user_id = ${userId}`;
const lineOf = async (userId: string) => (await raw<{ m: string | null }[]>`
  select reports_to_user_id as m from public.membership where organization_id = ${ORG} and user_id = ${userId}`)[0]!.m;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Loops Co", slug: "loops-co" });
  for (const [id, name, role] of [
    [ANA, "Ana Reyes", "office_manager"], [BEN, "Ben Cole", "office_manager"], [CY, "Cy Park", "dispatcher"],
    [DEE, "Dee Lund", "csr"], [TECH, "Tom Tech", "technician"],
  ] as const) {
    await raw`delete from public."user" where id = ${id}`;
    await raw`insert into public."user" (id, email, name) values (${id}, ${`${name.split(" ")[0]!.toLowerCase()}@loops-co.test`}, ${name})`;
    await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role)`;
  }
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in ${raw(PEOPLE)}`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`update public.membership set reports_to_user_id = null, active = true where organization_id = ${ORG}`;
});

run("finding loops already in who answers to whom", () => {
  it("finds none in a company whose lines are a tree, and says so with an empty list", async () => {
    await reportsTo(ANA, OWNER);
    await reportsTo(BEN, ANA);
    await reportsTo(CY, ANA);
    expect(await rules.reportingLoops(owner())).toEqual([]);
    expect(await rules.handlers.listReportingLoops(owner())).toEqual({ loops: [] });
  });

  it("names two people who report to each other, once, and leaves the lines alone", async () => {
    await reportsTo(ANA, BEN);
    await reportsTo(BEN, ANA);
    await reportsTo(DEE, ANA);
    const loops = await rules.reportingLoops(owner());
    expect(loops).toHaveLength(1);
    expect(loops[0]!.sentence).toBe("Ana Reyes reports to Ben Cole and Ben Cole reports to Ana Reyes.");
    expect(loops[0]!.people.map((p) => p.userId)).toEqual([ANA, BEN]);
    /** Dee only leads into it, and is not in it. */
    expect(loops[0]!.people.map((p) => p.userId)).not.toContain(DEE);
    /** Nothing was repaired. */
    expect(await lineOf(ANA)).toBe(BEN);
    expect(await lineOf(BEN)).toBe(ANA);
    expect(await lineOf(DEE)).toBe(ANA);
  });

  it("names a longer loop in reporting order and two separate loops separately", async () => {
    await reportsTo(ANA, BEN);
    await reportsTo(BEN, CY);
    await reportsTo(CY, ANA);
    await reportsTo(DEE, DEE);
    const loops = await rules.reportingLoops(owner());
    expect(loops.map((l) => l.sentence)).toEqual([
      "Ana Reyes reports to Ben Cole, Ben Cole reports to Cy Park, and Cy Park reports to Ana Reyes.",
      "Dee Lund is recorded as reporting to themselves.",
    ]);
  });

  it("still names a loop through somebody who has since left, and says so", async () => {
    await reportsTo(ANA, BEN);
    await reportsTo(BEN, ANA);
    await raw`update public.membership set active = false where organization_id = ${ORG} and user_id = ${BEN}`;
    const loops = await rules.reportingLoops(owner());
    expect(loops[0]!.sentence).toBe("Ana Reyes reports to Ben Cole (no longer works here) and Ben Cole (no longer works here) reports to Ana Reyes.");
    expect(loops[0]!.people.find((p) => p.userId === BEN)!.active).toBe(false);
  });

  it("is read with user:read, and a person who cannot read the lines cannot scan them", async () => {
    await expect(rules.reportingLoops(as(TECH, ["technician"]))).rejects.toThrow(PermissionError);
    await expect(rules.reportingLoops(as(DEE, ["csr"]))).rejects.toThrow(PermissionError);
    await expect(rules.reportingLoops(as(ANA, ["office_manager"]))).resolves.toEqual([]);
  });

  it("does not stop a new line closing a loop from being refused, scan or no scan", async () => {
    await reportsTo(ANA, BEN);
    await expect(rules.setReportsTo(owner(), { userId: BEN, reportsToUserId: ANA })).rejects.toThrow(ConflictError);
    expect(await lineOf(BEN)).toBeNull();
    expect(await rules.reportingLoops(owner())).toEqual([]);
  });
});
