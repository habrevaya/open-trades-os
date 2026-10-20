import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as projects from "../src/services/projects";
import * as scheduling from "../src/services/project-schedule";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M12. THE CLASH CHECK SEES VISITS AND CREWS.
 *
 * A crew sent to a phase's visit holds each of its members, so a member booked
 * by name on another phase that runs at once is flagged. A person held by two
 * visits in overlapping hours, one of them the project's, is flagged with the
 * hours and suggestions in words: another person with the skills who is free
 * then, or the same hours on another day. Nothing is moved.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m12clash:org");
const USER = fixtureId("m12clash:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

/** The first day of rough in, ten days out; electrical starts three days later and they overlap. */
const D = companyToday(10);
const day = (n: number) => time.addDays(D, n);
const at = (n: number, hour: number) => time.instantOfLocal(day(n), hour * 60, ZONE).toISOString();

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Two Places Co", slug: "visit-clash-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, 'commercial', 'Elm Street Partners') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Elm', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${propertyId})`;
});

async function tech(name: string, skills: string[] = []) {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name, skills)
    values (${ORG}, ${membership!.id}, ${name}, ${raw.json(skills)}) returning id`;
  return row!.id;
}

async function jobOf(phaseId: string) {
  const [link] = await raw<{ job_id: string }[]>`select job_id from public.project_job where project_phase_id = ${phaseId}`;
  return link!.job_id;
}

/** A visit on a job, from one hour to another, to people by name or to a crew. */
async function visit(jobId: string, start: string, end: string, people: { techs?: string[]; crew?: string } = {}) {
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, crew_id)
    values (${ORG}, ${jobId}, 'scheduled', ${start}::timestamptz, ${end}::timestamptz, ${people.crew ?? null}) returning id`;
  for (const t of people.techs ?? []) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${v!.id}, ${t})`;
  }
  return v!.id;
}

/** A job that is not the project's: a service call across town. */
async function serviceCall() {
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 9001, ${customerId}, ${propertyId}, 'scheduled', 'No heat at the bakery') returning id`;
  return job!.id;
}

async function fitout() {
  const project = await projects.create(owner(), { customerId, propertyId, name: "Elm fit out", contractValue: "80000" });
  const rough = await projects.addPhase(owner(), {
    projectId: project.id, name: "Rough in", billingValue: "40000", startsOn: day(0), endsOn: day(6),
  });
  const electrical = await projects.addPhase(owner(), {
    projectId: project.id, name: "Electrical", billingValue: "40000", startsOn: day(3), endsOn: day(9),
  });
  await projects.materialise(owner(), { id: project.id });
  return { project, rough, electrical };
}

run("the clash check reads crews", () => {
  it("counts a crew's members as booked through it, against their own booking on another phase", async () => {
    const { project, rough, electrical } = await fitout();
    const pat = await tech("Pat Lee");
    const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Framers') returning id`;
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crew!.id}, ${pat})`;
    await visit(await jobOf(rough.id), at(4, 8), at(4, 12), { crew: crew!.id });
    await visit(await jobOf(electrical.id), at(5, 8), at(5, 12), { techs: [pat] });

    const schedule = await scheduling.schedule(owner(), { projectId: project.id });
    expect(schedule.clashes.map((c) => [c.kind, c.name])).toEqual([["technician", "Pat Lee"]]);
    expect(schedule.clashes[0]!.statement).toBe(`Pat Lee is booked on Rough in and Electrical, which both run from ${day(3)} to ${day(6)}.`);
    /** On different days, so no two visits at once. */
    expect(schedule.visitClashes).toEqual([]);
  });
});

run("one person on two visits at once", () => {
  it("flags the hours, offers a free person with the skills and the same hours on other days, and moves nobody", async () => {
    const { project, rough, electrical } = await fitout();
    const sam = await tech("Sam Ortiz", ["electrical"]);
    const lee = await tech("Lee Park", ["electrical"]);
    const kim = await tech("Kim Diaz", ["electrical"]);
    await tech("Ray Nunez");
    await raw`update public.job set required_skills = ${raw.json(["electrical"])} where id = ${await jobOf(electrical.id)}`;

    /** Sam is on electrical from one to three and on rough in from two to four, the same afternoon. */
    const wiring = await visit(await jobOf(electrical.id), at(5, 13), at(5, 15), { techs: [sam] });
    const framing = await visit(await jobOf(rough.id), at(5, 14), at(5, 16), { techs: [sam] });
    /** Kim is busy then on the service call; Sam is busy the next afternoon too. */
    const call = await serviceCall();
    await visit(call, at(5, 12), at(5, 17), { techs: [kim] });
    await visit(call, at(6, 13), at(6, 14), { techs: [sam] });

    const schedule = await scheduling.schedule(owner(), { projectId: project.id });
    expect(schedule.visitClashes).toHaveLength(1);
    const clash = schedule.visitClashes[0]!;
    expect(clash).toMatchObject({
      technicianId: sam, name: "Sam Ortiz", visitId: wiring, phaseId: electrical.id, otherVisitId: framing, otherIsProject: true,
      from: at(5, 14), to: at(5, 15),
      freePeople: [{ id: lee, name: "Lee Park" }],
      freeDays: [day(7), day(8), day(9)],
    });
    expect(clash.statement).toMatch(/^Sam Ortiz is booked on #\d+ \(Electrical\) and on #\d+ \(Rough in\) at once, 2:00 PM to 3:00 PM on /);
    expect(clash.suggestions[0]).toMatch(/^Lee Park has the skills and is free then\. Give #\d+ \(Electrical\) to them on the board\.$/);
    expect(clash.suggestions[1]).toContain("Sam Ortiz is free at the same time on");
    expect(clash.suggestions[1]).toContain("inside Electrical's dates");
    /** The two phases run at once with Sam on both, so the phase check says so too. */
    expect(schedule.phases.find((p) => p.id === electrical.id)!.clashes).toHaveLength(1);

    /** Nothing moved: Sam is still on both, at the same hours. */
    const held = await raw`select 1 from public.visit_assignment where technician_id = ${sam}`;
    expect(held.length).toBe(3);
    const [w] = await raw<{ window_start: Date }[]>`select window_start from public.visit where id = ${wiring}`;
    expect(w!.window_start.toISOString()).toBe(at(5, 13));
  });

  it("names another visit only by its hours, reads a crew member as held, and skips a day the company is closed", async () => {
    const { project, rough } = await fitout();
    const ray = await tech("Ray Nunez");
    const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Framers') returning id`;
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id) values (${ORG}, ${crew!.id}, ${ray})`;
    const framing = await visit(await jobOf(rough.id), at(1, 8), at(1, 12), { crew: crew!.id });
    const call = await visit(await serviceCall(), at(1, 10), at(1, 11), { techs: [ray] });
    /** Open every day eight to five, except the weekday two days after. */
    const closed = new Date(`${day(2)}T12:00:00Z`).getUTCDay();
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at, closed)
        values (${ORG}, ${weekday}, '08:00', '17:00', ${weekday === closed})`;
    }

    const [clash] = (await scheduling.schedule(owner(), { projectId: project.id })).visitClashes;
    expect(clash).toMatchObject({ technicianId: ray, visitId: framing, otherVisitId: call, otherIsProject: false, freePeople: [] });
    expect(clash!.statement).toMatch(/^Ray Nunez \(with Framers\) is booked on #\d+ \(Rough in\) and on another visit at once, 10:00 AM to 11:00 AM on /);
    expect(clash!.statement).not.toContain("bakery");
    expect(clash!.suggestions[0]).toContain("with Framers, so another person means changing the crew");
    expect(clash!.freeDays).toEqual([day(3), day(4), day(5)]);
  });

  it("does not flag hours that only touch, a visit that is over, or two visits of somebody else's work", async () => {
    const { project, rough, electrical } = await fitout();
    const sam = await tech("Sam Ortiz");
    await visit(await jobOf(rough.id), at(4, 8), at(4, 10), { techs: [sam] });
    await visit(await jobOf(electrical.id), at(4, 10), at(4, 12), { techs: [sam] });
    const done = await visit(await jobOf(electrical.id), at(4, 8), at(4, 9), { techs: [sam] });
    await raw`update public.visit set status = 'completed' where id = ${done}`;
    const call = await serviceCall();
    await visit(call, at(4, 13), at(4, 15), { techs: [sam] });
    await visit(call, at(4, 14), at(4, 16), { techs: [sam] });
    expect((await scheduling.schedule(owner(), { projectId: project.id })).visitClashes).toEqual([]);
  });

  it("is read with job:read, like the rest of the schedule", async () => {
    const { project } = await fitout();
    await expect(scheduling.schedule(as(["csr"]), { projectId: project.id })).resolves.toMatchObject({ visitClashes: [] });
  });
});
