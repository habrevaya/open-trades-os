import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as people from "../src/services/people";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M24. PEOPLE AND CERTIFICATIONS.
 *
 * THE PROPERTY THIS FILE IS MOSTLY ABOUT: A REFUSAL CAN NAME AN EXPIRED
 * CERTIFICATION RATHER THAN AN ABSENT STRING.
 *
 * Before this module, `job_type.required_skills` and `crew.skills` were lists
 * of opaque strings and `services/crews.ts` could only ever say that one list
 * did not contain a string from the other. "This crew is not qualified for
 * epa_608" is true and does not tell a dispatcher whether nobody ever had it,
 * whether the person who had it left, or whether it ran out in March, and
 * those have three different answers before eight o'clock.
 *
 * The second property, and the one that is easy to get backwards: AN UNMAPPED
 * SKILL IS NOT A PASS. A skill no certification type grants comes back as
 * `uncertified`, which means this module knows nothing about it, and a caller
 * that read that as a clearance would turn silence into an approval.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m24:org");
const USER = fixtureId("m24:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const as = (role: Actor["roles"][number]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");

/**
 * THE TWO ROLES THAT TELL THE TWO PERMISSIONS APART.
 *
 * `office_manager` holds `user:read` and holds NEITHER `compliance:read` nor
 * `compliance:write`. `dispatcher` holds neither of the three. A permission
 * test run as a role holding neither of a pair cannot say which of them a
 * surface is guarded by: it refuses either way, and the test passes against
 * the wrong guard. So the roster is checked against both, and so is the
 * certification list, in opposite directions.
 */
const officeManager = () => as("office_manager");
const dispatcher = () => as("dispatcher");

/** Today in the company's zone, which is what the service bounds its day with. */
const TZ = "America/Chicago";
const today = (): string => time.dateIn(new Date(), TZ);
const daysFromToday = (days: number): string => {
  const base = Date.parse(`${today()}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
};

async function technician(key: string, name: string): Promise<string> {
  const userId = fixtureId(`m24:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`m24-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

let dana = "";
let sam = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cert Co", slug: "cert-co" });
  dana = await technician("dana", "Dana Reyes");
  sam = await technician("sam", "Sam Okafor");
});

/** The certification every test below hangs off: EPA 608, granting `epa_608`. */
async function epa608(over: Partial<{ renewalLeadDays: number; defaultValidMonths: number }> = {}) {
  return people.defineCertificationType(owner(), {
    code: "epa_608_universal",
    name: "EPA 608 Universal",
    authority: "EPA",
    grantsSkills: ["epa_608"],
    ...over,
  });
}

/* ======================================================== declaring a type */

run("declaring what this company recognises", () => {
  it("refuses a second type with the same code", async () => {
    /**
     * Two types with one code means the skill a job needs is granted by
     * whichever row came back first, and the two can disagree about whether
     * it expires.
     */
    await epa608();
    await expect(epa608()).rejects.toThrow(/already has a certification with the code/);
  });

  it("refuses a negative renewal notice", async () => {
    await expect(people.defineCertificationType(owner(), {
      code: "x", name: "X", renewalLeadDays: -1,
    })).rejects.toThrow(/not a negative one/);
  });

  it("keeps a retired type readable and refuses new holdings against it", async () => {
    const type = await epa608();
    await people.updateCertificationType(owner(), { id: type.id, active: false });

    const types = await people.listCertificationTypes(owner());
    expect(types.map((t) => t.active)).toEqual([false]);

    await expect(people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(400),
    })).rejects.toThrow(/has been retired/);
  });
});

/* ====================================================== recording a holding */

run("recording what somebody holds", () => {
  it("refuses an expiring certification with no expiry and nothing to compute one from", async () => {
    /**
     * The dangerous direction. A null expiry reads as "never expires"
     * everywhere in this module, so a lapsed card would be current forever on
     * the screen built to tell somebody to renew it.
     */
    const type = await epa608();
    await expect(people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
    })).rejects.toThrow(/needs the date it expires on/);
  });

  it("refuses an expiry on a certification declared not to expire", async () => {
    const type = await people.defineCertificationType(owner(), {
      code: "first_aid_life", name: "First aid, lifetime", expires: false,
    });
    await expect(people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(30),
    })).rejects.toThrow(/would put it on a renewal list it can never come off/);
  });

  it("computes the expiry from the type's validity and the issue date", async () => {
    const type = await epa608({ defaultValidMonths: 24 });
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, issuedOn: "2026-01-31",
    });
    /**
     * Clamped to the end of a short month. Rolling the day over would date a
     * licence issued on the 31st of January as expiring on the 2nd of March.
     */
    expect(held.expiresOn).toBe("2028-01-31");

    const short = await people.recordCertification(owner(), {
      technicianId: sam, certificationTypeId: type.id, issuedOn: "2025-12-31",
    });
    expect(short.expiresOn).toBe("2027-12-31");
  });

  it("clamps a computed expiry onto a shorter month", async () => {
    const type = await epa608({ defaultValidMonths: 1 });
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, issuedOn: "2026-01-31",
    });
    expect(held.expiresOn).toBe("2026-02-28");
  });

  it("refuses a certification that expires before it was issued", async () => {
    const type = await epa608();
    await expect(people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
      issuedOn: "2026-05-01", expiresOn: "2026-04-01",
    })).rejects.toThrow(/expires before it was issued/);
  });

  it("refuses the same licence number twice for one person", async () => {
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
      reference: "608-11223", expiresOn: daysFromToday(400),
    });
    await expect(people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
      reference: "608-11223", expiresOn: daysFromToday(800),
    })).rejects.toThrow(/already holds EPA 608 Universal under number 608-11223/);
  });

  it("lets a renewal be a second row, which is what keeps last year's answer", async () => {
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
      reference: "608-11223", issuedOn: "2024-01-01", expiresOn: "2026-01-01",
    });
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
      reference: "608-99887", issuedOn: "2026-01-01", expiresOn: daysFromToday(400),
    });

    const held = await people.listCertifications(owner(), { technicianId: dana });
    expect(held).toHaveLength(2);
    /**
     * The old row is still there and still says it was good until 2026, which
     * is the record "was Dana certified in March" is answered from.
     */
    expect(held.filter((h) => h.current)).toHaveLength(1);
  });

  it("refuses a technician who is not in this company", async () => {
    const type = await epa608();
    await expect(people.recordCertification(owner(), {
      technicianId: fixtureId("m24:nobody"), certificationTypeId: type.id,
      expiresOn: daysFromToday(10),
    })).rejects.toThrow(NotFoundError);
  });
});

/* ============================================================== verifying */

run("verifying a certification", () => {
  it("records both that it was verified and who verified it", async () => {
    /**
     * BOTH COLUMNS, READ BACK SEPARATELY. A test that only asserted the
     * timestamp would pass against a verify that never wrote the user, and
     * "who signed off on this licence" is the question an audit asks.
     */
    const type = await epa608();
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(400),
    });
    await people.verifyCertification(owner(), { id: held.id, note: "Saw the card" });

    const [row] = await raw<{ verified_at: Date | null; verified_by_user_id: string | null }[]>`
      select verified_at, verified_by_user_id from public.person_certification where id = ${held.id}`;
    expect(row!.verified_at).not.toBeNull();
    expect(row!.verified_by_user_id).toBe(USER);
  });

  it("refuses to verify something that is not ours", async () => {
    await expect(people.verifyCertification(owner(), { id: fixtureId("m24:ghost") }))
      .rejects.toThrow(NotFoundError);
  });
});

/* ========================================================== status changes */

run("suspending and revoking", () => {
  it("refuses a suspension with no reason on it", async () => {
    const type = await epa608();
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(400),
    });
    await expect(people.setCertificationStatus(owner(), { id: held.id, status: "suspended" }))
      .rejects.toThrow(/Say why/);
  });

  it("refuses to reinstate a revoked certification", async () => {
    /**
     * A revoked licence is not turned back on by editing a column. The
     * authority issues a new one, and a new one is a new record with its own
     * dates, which is the only version of this that is true on paper.
     */
    const type = await epa608();
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(400),
    });
    await people.setCertificationStatus(owner(), {
      id: held.id, status: "revoked", reason: "Falsified hours",
    });
    await expect(people.setCertificationStatus(owner(), { id: held.id, status: "active" }))
      .rejects.toThrow(/not reinstated by changing a column/);
  });

  it("clears the reason when a suspension is lifted", async () => {
    const type = await epa608();
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(400),
    });
    await people.setCertificationStatus(owner(), {
      id: held.id, status: "suspended", reason: "Under review",
    });
    const back = await people.setCertificationStatus(owner(), { id: held.id, status: "active" });
    expect(back.status).toBe("active");
    expect(back.statusReason).toBeNull();
  });
});

/* =================================================== the question that matters */

run("whether these people can do this work", () => {
  it("names the person and the date when the certification has expired", async () => {
    /**
     * THE WHOLE POINT OF THE MODULE. `crews.ts` can say "not qualified for
     * epa_608". This says whose licence it was and when it went, which is the
     * difference between a dispatcher reassigning the job and a dispatcher
     * ringing round to find out what changed.
     */
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
      issuedOn: "2024-03-03", expiresOn: "2026-03-03",
    });

    const { standing } = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["epa_608"], on: "2026-06-01",
    });
    expect(standing).toHaveLength(1);
    expect(standing[0]!.state).toBe("lapsed");
    expect(standing[0]!.explanation).toContain("Dana Reyes");
    expect(standing[0]!.explanation).toContain("2026-03-03");
    expect(standing[0]!.evidence[0]!.lapseReason).toBe("expired");
  });

  it("says absent, not lapsed, when nobody ever held it", async () => {
    await epa608();
    const { standing } = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["epa_608"], on: "2026-06-01",
    });
    expect(standing[0]!.state).toBe("absent");
    expect(standing[0]!.evidence).toEqual([]);
  });

  it("says uncertified for a skill no certification grants, which is not a pass", async () => {
    /**
     * The honest fourth state. A caller that collapsed this into "no problems
     * found" would turn a skill nobody has mapped into a clearance, which is
     * exactly the shape of the bug `crews.ts` avoids with `equipmentBasis`.
     */
    await epa608();
    const { standing } = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["backflow"], on: "2026-06-01",
    });
    expect(standing[0]!.state).toBe("uncertified");
    expect(standing[0]!.explanation).toContain("No certification in this company grants backflow");
  });

  it("covers the skill while the certification is live", async () => {
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: "2027-01-01",
    });
    const { standing } = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["epa_608"], on: "2026-06-01",
    });
    expect(standing[0]!.state).toBe("covered");
    expect(standing[0]!.explanation).toContain("Dana Reyes holds EPA 608 Universal");
  });

  it("counts the day it expires as a day it is still valid", async () => {
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: "2026-06-01",
    });
    const onTheDay = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["epa_608"], on: "2026-06-01",
    });
    expect(onTheDay.standing[0]!.state).toBe("covered");

    const dayAfter = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["epa_608"], on: "2026-06-02",
    });
    expect(dayAfter.standing[0]!.state).toBe("lapsed");
  });

  it("refuses a revoked certification whose expiry is still in the future", async () => {
    /**
     * Expiry and revocation are different facts and only one of them is a
     * date. A check that looked at the date alone would clear somebody an
     * authority has taken the licence off.
     */
    const type = await epa608();
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: "2029-01-01",
    });
    await people.setCertificationStatus(owner(), {
      id: held.id, status: "revoked", reason: "Falsified hours",
    });

    const { standing } = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["epa_608"], on: "2026-06-01",
    });
    expect(standing[0]!.state).toBe("lapsed");
    expect(standing[0]!.explanation).toContain("has been revoked");
  });

  it("is covered when any one of the people asked about holds it", async () => {
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: "2026-01-01",
    });
    await people.recordCertification(owner(), {
      technicianId: sam, certificationTypeId: type.id, expiresOn: "2029-01-01",
    });
    const { standing } = await people.standingFor(owner(), {
      technicianIds: [dana, sam], skills: ["epa_608"], on: "2026-06-01",
    });
    expect(standing[0]!.state).toBe("covered");
    expect(standing[0]!.explanation).toContain("Sam Okafor");
  });

  it("stops recognising a holding of a retired type", async () => {
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: "2029-01-01",
    });
    await people.updateCertificationType(owner(), { id: type.id, active: false });

    const { standing } = await people.standingFor(owner(), {
      technicianIds: [dana], skills: ["epa_608"], on: "2026-06-01",
    });
    /**
     * Nothing in this company grants `epa_608` any more, so the honest answer
     * is that this module cannot say, rather than that Dana is covered by a
     * certification the company has stopped recognising.
     */
    expect(standing[0]!.state).toBe("uncertified");
  });
});

/* ========================================================= the renewal list */

run("what is about to run out", () => {
  it("uses each type's own notice period rather than one number for the company", async () => {
    /**
     * A licence that takes a day of paperwork and one that takes six weeks of
     * continuing education do not want the same warning, and a single company
     * wide window is wrong for one of them whichever number is chosen.
     */
    const quick = await people.defineCertificationType(owner(), {
      code: "quick", name: "Quick to renew", renewalLeadDays: 7,
    });
    const slow = await people.defineCertificationType(owner(), {
      code: "slow", name: "Slow to renew", renewalLeadDays: 90,
    });
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: quick.id, expiresOn: daysFromToday(30),
    });
    await people.recordCertification(owner(), {
      technicianId: sam, certificationTypeId: slow.id, expiresOn: daysFromToday(30),
    });

    const due = await people.expiringSoon(owner());
    expect(due.map((d) => d.code)).toEqual(["slow"]);
    expect(due[0]!.daysRemaining).toBe(30);
    expect(due[0]!.renewalLeadDays).toBe(90);
  });

  it("takes an explicit window when one is asked for", async () => {
    const quick = await people.defineCertificationType(owner(), {
      code: "quick", name: "Quick to renew", renewalLeadDays: 7,
    });
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: quick.id, expiresOn: daysFromToday(30),
    });
    expect(await people.expiringSoon(owner(), { within: 60 })).toHaveLength(1);
    expect(await people.expiringSoon(owner(), { within: 10 })).toHaveLength(0);
  });

  it("keeps what has already expired on the list, flagged and negative", async () => {
    /**
     * A renewal list that drops a certification the moment it lapses is empty
     * exactly when somebody needed to look at it.
     */
    const type = await epa608();
    await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(-5),
    });
    const due = await people.expiringSoon(owner());
    expect(due).toHaveLength(1);
    expect(due[0]!.daysRemaining).toBe(-5);
    expect(due[0]!.current).toBe(false);
    expect(due[0]!.lapseReason).toBe("expired");
  });

  it("leaves out a revoked certification, which is reissued rather than renewed", async () => {
    const type = await epa608();
    const held = await people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(10),
    });
    expect(await people.expiringSoon(owner())).toHaveLength(1);

    await people.setCertificationStatus(owner(), {
      id: held.id, status: "revoked", reason: "Falsified hours",
    });
    expect(await people.expiringSoon(owner())).toHaveLength(0);
  });
});

/* ============================================================== the roster */

run("the roster", () => {
  it("lists memberships and the technician profile attached to each", async () => {
    const roster = await people.listPeople(owner());
    /** The seeded owner membership, plus the two technicians. */
    expect(roster).toHaveLength(3);
    expect(roster.filter((p) => p.technicianId !== null).map((p) => p.displayName).sort())
      .toEqual(["Dana Reyes", "Sam Okafor"]);
    expect(roster.find((p) => p.role === "owner")!.technicianId).toBeNull();
  });
});

run("the people on the settings screen", () => {
  it("shows an owner every colleague, not only themselves", async () => {
    /**
     * The screen joined `membership` to `public."user"`, whose policy
     * returns only the caller's own row, so an owner saw a company of one.
     * Shown here first, so this test says what it guards against.
     */
    const joined = await inTenant(owner(), (tx) => tx.select({ email: schema.user.email })
      .from(schema.membership)
      .innerJoin(schema.user, eq(schema.user.id, schema.membership.userId))
      .where(eq(schema.membership.active, true)));
    expect(joined).toHaveLength(1);

    const people_ = await people.members(owner());
    expect(people_.map((p) => p.email).sort()).toEqual(
      expect.arrayContaining(["m24-dana@test.local", "m24-sam@test.local"]),
    );
    expect(people_).toHaveLength(3);
    expect(people_.find((p) => p.email === "m24-dana@test.local")!.membership.role)
      .toBe("technician");
  });

  it("leaves out a membership that has been switched off", async () => {
    await raw`update public.membership set active = false
              where user_id = ${fixtureId("m24:tech:sam")}`;
    const people_ = await people.members(owner());
    expect(people_.map((p) => p.email)).not.toContain("m24-sam@test.local");
  });

  it("is user:read, which a dispatcher does not hold", async () => {
    await expect(people.members(dispatcher())).rejects.toThrow(PermissionError);
    await expect(people.members(officeManager())).resolves.toHaveLength(3);
  });
});

/* ========================================================== the permissions */

run("who may read what", () => {
  it("lets the office manager read the roster, which is user:read and not compliance", async () => {
    /**
     * HALF OF THE PAIR THAT MAKES THIS TEST MEAN ANYTHING. `office_manager`
     * holds `user:read` and holds neither compliance permission, so this
     * passing proves the roster is NOT guarded by compliance, and the
     * certification test below proves the certifications are.
     */
    await expect(people.listPeople(officeManager())).resolves.toHaveLength(3);
  });

  it("refuses the roster to a dispatcher, who holds no user:read", async () => {
    await expect(people.listPeople(dispatcher())).rejects.toThrow(PermissionError);
  });

  it("refuses the certification list to the office manager, who holds no compliance:read", async () => {
    /** The other half. Same role, opposite answer, so the two guards are distinguishable. */
    await expect(people.listCertifications(officeManager())).rejects.toThrow(PermissionError);
  });

  it("refuses recording a certification to the office manager", async () => {
    const type = await epa608();
    await expect(people.recordCertification(officeManager(), {
      technicianId: dana, certificationTypeId: type.id, expiresOn: daysFromToday(10),
    })).rejects.toThrow(PermissionError);
  });

  it("lets an administrator do both, so the refusals above are about the permission", async () => {
    /**
     * The vacuous case. If every call in this block threw for some unrelated
     * reason, the four tests above would pass while proving nothing.
     */
    await epa608();
    await expect(people.listCertifications(as("admin"))).resolves.toEqual([]);
    await expect(people.listPeople(as("admin"))).resolves.toHaveLength(3);
  });
});

/* ------------------------------------------------------------------------ */

run("the guards refuse rather than silently doing nothing", () => {
  it("throws a conflict rather than returning a result when a rule is broken", async () => {
    const type = await epa608();
    await expect(people.recordCertification(owner(), {
      technicianId: dana, certificationTypeId: type.id,
    })).rejects.toThrow(ConflictError);
  });
});
