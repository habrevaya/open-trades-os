import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as crews from "../src/services/crews";
import * as onCall from "../src/services/on-call";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * CREWS, AND WHO HAS THE PHONE TONIGHT
 *
 * `crew`, `crew_member` and `on_call_rotation` shipped in the first migration
 * and no service had ever written one of them. A landscape company had
 * nowhere to say what a crew is, and the answer to "who do I ring at two in
 * the morning" was not in the product at all.
 *
 * The property most of this file is about: A CREW SHORT THE EQUIPMENT THE
 * WORK NEEDS IS NOT AVAILABLE, AND IS TOLD SO AT ASSIGNMENT TIME. The failure
 * it prevents costs a truck roll, a day of crew time nobody sold and a
 * customer who took the morning off, and it is not visible anywhere before
 * the crew arrives.
 *
 * The property the on call half is about: AT MOST ONE PERSON IS ON CALL AT
 * ANY INSTANT. Two rows covering one hour is two technicians each believing
 * the other has the phone, and it is discovered by a customer.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("crews:org");
const USER = fixtureId("crews:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** A dispatcher holds visit:dispatch and does NOT hold payroll:configure. */
const dispatcher = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

/** A technician, with the user and membership rows the column requires. */
async function technician(key: string, name: string, active = true): Promise<string> {
  const userId = fixtureId(`crews:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`crews-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${m!.id}, ${name}, ${active}) returning id`;
  return t!.id;
}

/** A job type that declares what the work needs. */
async function jobType(
  name: string, assets: string[], skills: string[] = [],
): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, required_asset_ids, required_skills)
    values (${ORG}, ${name}, ${raw.json(assets as never)}, ${raw.json(skills as never)})
    returning id`;
  return row!.id;
}

async function job(jobTypeId: string | null, businessUnitId: string | null = null): Promise<string> {
  const [n] = await raw<{ next: number }[]>`
    select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id,
                            business_unit_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, ${jobTypeId},
            ${businessUnitId}, 'scheduled', 'Take the tree down')
    returning id`;
  return row!.id;
}

async function visitOn(jobId: string, date: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end)
    values (${ORG}, ${jobId}, 1, 'unassigned',
            ${`${date}T14:00:00Z`}::timestamptz, ${`${date}T18:00:00Z`}::timestamptz)
    returning id`;
  return row!.id;
}

/** A certification type this company recognises, and the skills it grants. */
async function certificationType(
  code: string, name: string, grants: string[],
): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.certification_type (organization_id, code, name, grants_skills)
    values (${ORG}, ${code}, ${name}, ${raw.json(grants as never)})
    returning id`;
  return row!.id;
}

/** A holding of one, with the expiry and status that decide whether it counts. */
async function certification(
  technicianId: string, typeId: string,
  expiresOn: string | null, status = "active",
): Promise<void> {
  await raw`
    insert into public.person_certification
      (organization_id, technician_id, certification_type_id, expires_on, status)
    values (${ORG}, ${technicianId}, ${typeId}, ${expiresOn}, ${status}::certification_status)`;
}

/** Approved time off, which is the only kind the board and this service count. */
async function timeOff(technicianId: string, from: string, to: string, approved = true) {
  await raw`
    insert into public.time_off (organization_id, technician_id, starts_at, ends_at, approved)
    values (${ORG}, ${technicianId}, ${`${from}T00:00:00Z`}::timestamptz,
            ${`${to}T23:59:00Z`}::timestamptz, ${approved})`;
}

async function fixtures(): Promise<void> {
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'residential', 'Crew Customer') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Crew Court', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Crew Co", slug: "crew-co" });
  await fixtures();
});

/* ========================================================== defining a crew */

run("defining a crew", () => {
  it("refuses a production rate with no unit", async () => {
    /**
     * Half a rate reads as capacity on every screen and means nothing. Eight
     * hundred a day is square feet, linear feet or cubic yards, and the three
     * are different jobs.
     */
    await expect(crews.create(owner(), {
      name: "Tree crew", productionRatePerDay: "800",
    })).rejects.toThrow(/production rate needs its unit/);
  });

  it("refuses a production unit with no rate", async () => {
    await expect(crews.create(owner(), {
      name: "Tree crew", productionUnit: "square feet",
    })).rejects.toThrow(/needs its rate/);
  });

  it("takes the pair together", async () => {
    const crew = await crews.create(owner(), {
      name: "Tree crew", productionRatePerDay: "800", productionUnit: "square feet",
    });
    expect(crew.productionUnit).toBe("square feet");
  });

  it("refuses an edit that leaves half a rate behind", async () => {
    /**
     * Checked against the RESULT of the edit. A check that only looked at the
     * incoming fields would let somebody clear the unit on a crew that
     * already has a rate, which is the state `create` refuses.
     */
    const crew = await crews.create(owner(), {
      name: "Tree crew", productionRatePerDay: "800", productionUnit: "square feet",
    });
    await expect(crews.update(owner(), { id: crew.id, productionUnit: null }))
      .rejects.toThrow(/production rate needs its unit/);
  });
});

/* ------------------------------------------------------------------ members */

run("who is on the crew", () => {
  it("refuses two leads", async () => {
    const crew = await crews.create(owner(), { name: "Tree crew" });
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await expect(crews.setMembers(owner(), {
      id: crew.id,
      members: [{ technicianId: a, isLead: true }, { technicianId: b, isLead: true }],
    })).rejects.toThrow(/A crew has one lead/);
  });

  it("refuses the same technician twice", async () => {
    const crew = await crews.create(owner(), { name: "Tree crew" });
    const a = await technician("a", "Ana");
    await expect(crews.setMembers(owner(), {
      id: crew.id, members: [{ technicianId: a }, { technicianId: a }],
    })).rejects.toThrow(/same technician on the crew twice/);
  });

  it("refuses somebody who is not an active technician here", async () => {
    const crew = await crews.create(owner(), { name: "Tree crew" });
    const gone = await technician("gone", "Departed", false);
    await expect(crews.setMembers(owner(), {
      id: crew.id, members: [{ technicianId: gone }],
    })).rejects.toThrow(/not active in this company/);
  });

  it("replaces the whole list rather than adding to it", async () => {
    const crew = await crews.create(owner(), { name: "Tree crew" });
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await crews.setMembers(owner(), {
      id: crew.id, members: [{ technicianId: a, isLead: true }, { technicianId: b }],
    });
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: b, isLead: true }] });

    const listed = await crews.list(owner());
    const found = listed.find((c) => c.id === crew.id);
    expect(found?.members.map((m) => m.technicianId)).toEqual([b]);
  });
});

/* ------------------------------------------------- can this crew take this job */

run("can this crew take this job", () => {
  const kitted = async () => {
    const crew = await crews.create(owner(), {
      name: "Tree crew", requiredAssetIds: ["chipper", "bucket-truck"], skills: ["climbing"],
    });
    const a = await technician("a", "Ana");
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: a, isLead: true }] });
    return { crewId: crew.id, technicianId: a };
  };

  it("refuses a crew that does not carry what the work needs, and names it", async () => {
    /**
     * THE DEFECT THIS WHOLE FILE EXISTS FOR. A tree crew without the chipper
     * cannot take the job no matter who is standing in the truck, and the
     * only place that can be said usefully is before somebody drives there.
     */
    const { crewId } = await kitted();
    const jobId = await job(await jobType("Tree removal", ["chipper", "stump-grinder"]));

    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.canTake).toBe(false);
    expect(verdict.missingEquipment).toEqual(["stump-grinder"]);
    expect(verdict.blockers.map((b) => b.code)).toContain("missing_equipment");
    expect(verdict.blockers[0]?.explanation).toContain("stump-grinder");
  });

  it("clears a crew that carries all of it", async () => {
    const { crewId } = await kitted();
    const jobId = await job(await jobType("Tree removal", ["chipper"]));
    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.canTake).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it("refuses a crew missing a skill the work needs", async () => {
    const { crewId } = await kitted();
    const jobId = await job(await jobType("Tree removal", [], ["crane"]));
    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.missingSkills).toEqual(["crane"]);
    expect(verdict.canTake).toBe(false);
  });

  /**
   * THE THREE TESTS BELOW ARE THE WHOLE OF WHY M24 WAS BUILT.
   *
   * Before them this file had one source for skills: a list somebody typed
   * onto the crew record. It can say "not qualified for crane" and nothing
   * else, and a dispatcher holding that sentence at seven in the morning
   * cannot tell whether to reassign the job or ring the training provider.
   *
   * Each of these drives the certification path to a DIFFERENT verdict than
   * the typed list alone would give, which is the only way to tell that the
   * certification path is being consulted at all. A test where both sources
   * agree would pass with `skillStanding` deleted.
   */
  it("refuses on an expired certification, and names whose and when", async () => {
    /**
     * The typed list SAYS the crew climbs, so the old check passes this. The
     * refusal here comes from the certification and from nowhere else.
     */
    const { crewId, technicianId } = await kitted();
    const typeId = await certificationType("climb-1", "Aerial rescue", ["climbing"]);
    await certification(technicianId, typeId, "2026-05-01");
    const jobId = await job(await jobType("Tree removal", [], ["climbing"]));

    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.canTake).toBe(false);
    expect(verdict.missingSkills).toEqual(["climbing"]);
    const refusal = verdict.blockers.find((b) => b.code === "missing_skills")?.explanation ?? "";
    expect(refusal).toContain("Ana");
    expect(refusal).toContain("Aerial rescue");
    expect(refusal).toContain("2026-05-01");
  });

  it("clears a skill the crew record omits when somebody holds a live certification", async () => {
    /**
     * The converse, and the reason `covered` beats the typed list rather than
     * being ANDed with it: the crew record does not say "crane", a recorded
     * live certification does, and refusing here is a crew sitting in the
     * yard because of a string nobody remembered to type.
     */
    const { crewId, technicianId } = await kitted();
    const typeId = await certificationType("crane-1", "Crane operator", ["crane"]);
    await certification(technicianId, typeId, "2027-01-01");
    const jobId = await job(await jobType("Tree removal", [], ["crane"]));

    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.missingSkills).toEqual([]);
    expect(verdict.canTake).toBe(true);
  });

  it("refuses when the skill is recognised here and nobody on the crew holds it", async () => {
    /**
     * `absent`, which is a different sentence from `lapsed` and a different
     * morning's work: nobody to chase a renewal for, somebody to send on a
     * course. The typed list would pass this one too.
     */
    const { crewId } = await kitted();
    await certificationType("climb-2", "Aerial rescue", ["climbing"]);
    const jobId = await job(await jobType("Tree removal", [], ["climbing"]));

    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.canTake).toBe(false);
    const refusal = verdict.blockers.find((b) => b.code === "missing_skills")?.explanation ?? "";
    expect(refusal).toContain("Nobody here holds a certification for climbing");
  });

  it("falls back to the crew record for a skill no certification here grants", async () => {
    /**
     * `uncertified` is NOT a clearance. A company that has declared no type
     * granting "crane" gets exactly the behaviour it had before M24, which is
     * the typed list, rather than a silent pass on an unmapped skill.
     */
    const { crewId, technicianId } = await kitted();
    const typeId = await certificationType("climb-3", "Aerial rescue", ["climbing"]);
    await certification(technicianId, typeId, "2027-01-01");
    const jobId = await job(await jobType("Tree removal", [], ["crane"]));

    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.missingSkills).toEqual(["crane"]);
    expect(verdict.canTake).toBe(false);
  });

  it("refuses a crew with nobody on it", async () => {
    const crew = await crews.create(owner(), { name: "Empty crew" });
    const jobId = await job(null);
    const verdict = await crews.canTake(owner(), { id: crew.id, jobId, on: "2026-06-02" });
    expect(verdict.blockers.map((b) => b.code)).toContain("no_members");
    expect(verdict.headcount).toEqual({ onCrew: 0, availableOn: 0, offOn: 0 });
  });

  it("refuses a crew whose whole team is on approved time off that day", async () => {
    const { crewId, technicianId } = await kitted();
    await timeOff(technicianId, "2026-06-01", "2026-06-05");
    const jobId = await job(null);
    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.blockers.map((b) => b.code)).toContain("everybody_off");
    expect(verdict.headcount.availableOn).toBe(0);
  });

  it("ignores time off nobody has approved", async () => {
    /**
     * Matching the dispatch board, which draws an empty column for approved
     * leave only. A requested day that nobody has signed off is not yet a
     * reason to refuse work.
     */
    const { crewId, technicianId } = await kitted();
    await timeOff(technicianId, "2026-06-01", "2026-06-05", false);
    const jobId = await job(null);
    const verdict = await crews.canTake(owner(), { id: crewId, jobId, on: "2026-06-02" });
    expect(verdict.headcount.availableOn).toBe(1);
    expect(verdict.canTake).toBe(true);
  });

  it("refuses when the lead is off, even though somebody else is there", async () => {
    const crew = await crews.create(owner(), { name: "Tree crew" });
    const lead = await technician("lead", "Lee");
    const hand = await technician("hand", "Haz");
    await crews.setMembers(owner(), {
      id: crew.id,
      members: [{ technicianId: lead, isLead: true }, { technicianId: hand }],
    });
    await timeOff(lead, "2026-06-02", "2026-06-02");

    const jobId = await job(null);
    const verdict = await crews.canTake(owner(), { id: crew.id, jobId, on: "2026-06-02" });
    expect(verdict.headcount.availableOn).toBe(1);
    expect(verdict.blockers.map((b) => b.code)).toContain("lead_off");
  });

  it("does not invent a lead for a crew that never named one", async () => {
    const crew = await crews.create(owner(), { name: "Tree crew" });
    const a = await technician("a", "Ana");
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: a }] });
    const verdict = await crews.canTake(owner(), { id: crew.id, jobId: await job(null), on: "2026-06-02" });
    expect(verdict.leadDesignated).toBe(false);
    expect(verdict.canTake).toBe(true);
  });

  it("refuses a retired crew", async () => {
    const { crewId } = await kitted();
    await crews.update(owner(), { id: crewId, active: false });
    const verdict = await crews.canTake(owner(), { id: crewId, jobId: await job(null), on: "2026-06-02" });
    expect(verdict.blockers.map((b) => b.code)).toContain("crew_inactive");
  });

  it("says when the job declares nothing, rather than calling that a clearance", async () => {
    /**
     * An empty `missingEquipment` on a job with no type is a statement about
     * an empty list, not about the crew. A caller that cannot tell those
     * apart reads the second as permission.
     */
    const { crewId } = await kitted();
    const verdict = await crews.canTake(owner(), { id: crewId, jobId: await job(null), on: "2026-06-02" });
    expect(verdict.equipmentBasis).toBe("none_declared");
  });

  it("refuses a crew belonging to another business unit", async () => {
    const [unitA] = await raw<{ id: string }[]>`
      insert into public.business_unit (organization_id, name) values (${ORG}, 'North') returning id`;
    const [unitB] = await raw<{ id: string }[]>`
      insert into public.business_unit (organization_id, name) values (${ORG}, 'South') returning id`;
    const crew = await crews.create(owner(), { name: "North crew", businessUnitId: unitA!.id });
    const a = await technician("a", "Ana");
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: a }] });

    const jobId = await job(null, unitB!.id);
    const verdict = await crews.canTake(owner(), { id: crew.id, jobId, on: "2026-06-02" });
    expect(verdict.blockers.map((b) => b.code)).toContain("different_business_unit");
  });

  it("lists every crew with its reason rather than hiding the ones that cannot", async () => {
    const { crewId } = await kitted();
    const bare = await crews.create(owner(), { name: "Bare crew" });
    const b = await technician("b", "Ben");
    await crews.setMembers(owner(), { id: bare.id, members: [{ technicianId: b }] });

    const jobId = await job(await jobType("Tree removal", ["chipper"]));
    const answer = await crews.crewsFor(owner(), { jobId, on: "2026-06-02" });

    expect(answer.crews.map((c) => c.crewId).sort()).toEqual([crewId, bare.id].sort());
    const bareVerdict = answer.crews.find((c) => c.crewId === bare.id);
    expect(bareVerdict?.canTake).toBe(false);
    expect(bareVerdict?.missingEquipment).toEqual(["chipper"]);
  });
});

/* -------------------------------------------------- putting a crew on a visit */

run("putting a crew on a visit", () => {
  const kitted = async () => {
    const crew = await crews.create(owner(), { name: "Tree crew", requiredAssetIds: ["chipper"] });
    const a = await technician("a", "Ana");
    await crews.setMembers(owner(), { id: crew.id, members: [{ technicianId: a, isLead: true }] });
    return { crewId: crew.id, technicianId: a };
  };

  it("refuses the assignment and says what is missing", async () => {
    const { crewId } = await kitted();
    const jobId = await job(await jobType("Tree removal", ["chipper", "crane"]));
    const visitId = await visitOn(jobId, "2026-06-02");

    await expect(crews.assign(owner(), { id: visitId, crewId }))
      .rejects.toThrow(/does not carry crane/);

    const [row] = await raw<{ crew_id: string | null }[]>`
      select crew_id from public.visit where id = ${visitId}`;
    expect(row?.crew_id).toBeNull();
  });

  it("assigns a crew that can take it, and dispatches the visit", async () => {
    const { crewId } = await kitted();
    const jobId = await job(await jobType("Tree removal", ["chipper"]));
    const visitId = await visitOn(jobId, "2026-06-02");

    const result = await crews.assign(owner(), { id: visitId, crewId });
    expect(result.status).toBe("dispatched");

    const [row] = await raw<{ crew_id: string | null; status: string }[]>`
      select crew_id, status from public.visit where id = ${visitId}`;
    expect(row?.crew_id).toBe(crewId);
    expect(row?.status).toBe("dispatched");
  });

  it("leaves technician dispatch alone: no assignment row is written", async () => {
    /**
     * The schema's rule, in a test: a visit carries a crew OR a list of
     * individually assigned technicians. A crew assignment that also wrote
     * `visit_assignment` would put the crew's members into the technician
     * board's columns and double count their day.
     */
    const { crewId } = await kitted();
    const visitId = await visitOn(await job(null), "2026-06-02");
    await crews.assign(owner(), { id: visitId, crewId });

    const rows = await raw`select id from public.visit_assignment where visit_id = ${visitId}`;
    expect(rows.length).toBe(0);
  });

  it("judges availability on the day of the visit, not on today", async () => {
    /**
     * The subtle one. Assigning Thursday's work on Monday has to ask about
     * Thursday; a check against today clears a crew whose only member is on
     * holiday that week, and nobody finds out until Thursday.
     */
    const { crewId, technicianId } = await kitted();
    await timeOff(technicianId, "2026-06-02", "2026-06-02");
    const visitId = await visitOn(await job(null), "2026-06-02");

    await expect(crews.assign(owner(), { id: visitId, crewId }))
      .rejects.toThrow(/approved time off on 2026-06-02/);
  });

  it("refuses to reassign a completed visit", async () => {
    const { crewId } = await kitted();
    const visitId = await visitOn(await job(null), "2026-06-02");
    await raw`update public.visit set status = 'completed' where id = ${visitId}`;
    await expect(crews.assign(owner(), { id: visitId, crewId }))
      .rejects.toThrow(/cannot be reassigned/);
  });
});

/* =============================================================== on call */

run("who gets the two in the morning call", () => {
  const WINDOW = { startsAt: "2026-06-05T22:00:00.000Z", endsAt: "2026-06-08T12:00:00.000Z" };

  it("refuses a second person over the same hours", async () => {
    /**
     * THE INVARIANT. Two rows covering one instant means two technicians each
     * believing the other has the phone, and it is discovered at two in the
     * morning by a customer who is still waiting.
     */
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW });

    await expect(onCall.schedule(owner(), {
      technicianId: b,
      startsAt: "2026-06-06T00:00:00.000Z",
      endsAt: "2026-06-09T00:00:00.000Z",
    })).rejects.toThrow(/already on call/);
  });

  it("allows the next shift to start exactly where the last one ends", async () => {
    // Half open on both sides. Refusing this would make a clean rota
    // impossible to build.
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW });
    const second = await onCall.schedule(owner(), {
      technicianId: b, startsAt: WINDOW.endsAt, endsAt: "2026-06-10T12:00:00.000Z",
    });
    expect(second.technicianId).toBe(b);
  });

  it("treats a company wide shift as colliding with a branch shift", async () => {
    const [unit] = await raw<{ id: string }[]>`
      insert into public.business_unit (organization_id, name) values (${ORG}, 'North') returning id`;
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW, businessUnitId: unit!.id });

    await expect(onCall.schedule(owner(), { technicianId: b, ...WINDOW }))
      .rejects.toThrow(/already on call/);
  });

  it("refuses a shift that ends before it starts", async () => {
    const a = await technician("a", "Ana");
    await expect(onCall.schedule(owner(), {
      technicianId: a, startsAt: WINDOW.endsAt, endsAt: WINDOW.startsAt,
    })).rejects.toThrow(/ends before it starts/);
  });

  it("needs payroll rights to declare what the night pays", async () => {
    /**
     * A rate multiplier is a statement about what somebody is owed. The
     * dispatcher building the rota is not the person entitled to make it, and
     * the catalogue separates `payroll:configure` for exactly that reason.
     */
    const a = await technician("a", "Ana");
    await expect(onCall.schedule(dispatcher(), {
      technicianId: a, ...WINDOW, rateMultiplier: "1.5",
    })).rejects.toThrow(/payroll:configure/);
  });

  it("lets a dispatcher build the rota when no pay is declared on it", async () => {
    const a = await technician("a", "Ana");
    const shift = await onCall.schedule(dispatcher(), { technicianId: a, ...WINDOW });
    expect(shift.rateMultiplier).toBeNull();
  });

  it("refuses a multiplier that pays less for being woken at two", async () => {
    const a = await technician("a", "Ana");
    await expect(onCall.schedule(owner(), {
      technicianId: a, ...WINDOW, rateMultiplier: "0.8",
    })).rejects.toThrow(/below 1/);
  });

  it("answers who is on call, half open at the boundary", async () => {
    const a = await technician("a", "Ana");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW });

    const atStart = await onCall.whoIsOnCall(owner(), { at: WINDOW.startsAt });
    expect(atStart.onCall?.technicianId).toBe(a);

    const atEnd = await onCall.whoIsOnCall(owner(), { at: WINDOW.endsAt });
    expect(atEnd.onCall).toBeNull();
  });

  it("says in words that nobody is on, rather than coming back blank", async () => {
    const answer = await onCall.whoIsOnCall(owner(), { at: WINDOW.startsAt });
    expect(answer.onCall).toBeNull();
    expect(answer.explanation).toMatch(/Nobody is on call/);
  });
});

run("the handover", () => {
  const WINDOW = { startsAt: "2026-06-05T22:00:00.000Z", endsAt: "2026-06-08T12:00:00.000Z" };
  const MIDWAY = "2026-06-07T00:00:00.000Z";

  it("ends the worked shift where it really ended and starts a new one", async () => {
    /**
     * Not an edit. An update in place would rewrite the night so that the
     * person who took the calls until midnight was never on, which is wrong
     * on the rota, wrong on an overtime run, and wrong in the one
     * conversation where it matters.
     */
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW, rateMultiplier: "1.5" });

    const result = await onCall.handOver(owner(), { toTechnicianId: b, at: MIDWAY });
    expect(result.from.technicianId).toBe(a);
    expect(result.to.technicianId).toBe(b);

    const before = await onCall.whoIsOnCall(owner(), { at: "2026-06-06T02:00:00.000Z" });
    expect(before.onCall?.technicianId).toBe(a);
    const after = await onCall.whoIsOnCall(owner(), { at: "2026-06-07T02:00:00.000Z" });
    expect(after.onCall?.technicianId).toBe(b);
    // The night still pays what it paid. A handover is not the moment to
    // change that.
    expect(after.onCall?.rateMultiplier).toBe("1.500000");
  });

  it("leaves no gap and no overlap across the handover", async () => {
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW });
    await onCall.handOver(owner(), { toTechnicianId: b, at: MIDWAY });

    const shifts = await onCall.list(owner(), { from: WINDOW.startsAt, to: WINDOW.endsAt });
    expect(shifts.length).toBe(2);
    expect(shifts[0]?.endsAt.toISOString()).toBe(shifts[1]?.startsAt.toISOString());
    expect(shifts[1]?.endsAt.toISOString()).toBe(WINDOW.endsAt);
  });

  it("refuses a handover when nobody is on call", async () => {
    const b = await technician("b", "Ben");
    await expect(onCall.handOver(owner(), { toTechnicianId: b, at: MIDWAY }))
      .rejects.toThrow(/nothing to hand over/);
  });

  it("refuses handing the phone to the person already holding it", async () => {
    const a = await technician("a", "Ana");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW });
    await expect(onCall.handOver(owner(), { toTechnicianId: a, at: MIDWAY }))
      .rejects.toThrow(/already on call/);
  });

  it("refuses a handover on the boundary, which would be a shift of no length", async () => {
    const a = await technician("a", "Ana");
    const b = await technician("b", "Ben");
    await onCall.schedule(owner(), { technicianId: a, ...WINDOW });
    await expect(onCall.handOver(owner(), { toTechnicianId: b, at: WINDOW.startsAt }))
      .rejects.toThrow(/shift of no length/);
  });

  it("is a ConflictError, so the HTTP layer answers 409 rather than 500", async () => {
    const b = await technician("b", "Ben");
    await expect(onCall.handOver(owner(), { toTechnicianId: b, at: MIDWAY }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
