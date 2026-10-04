import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { people as peopleCore, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf,
  type ServiceContext,
} from "./context";
import { listFilter } from "./custom-fields";

/**
 * M24. PEOPLE AND CERTIFICATIONS.
 *
 * WHAT THIS MODULE IS FOR, IN ONE SENTENCE: who may do what, and the proof.
 *
 * `services/crews.ts` already refuses a crew that is missing a skill the work
 * needs, by comparing `crew.skills` against `job_type.required_skills` as
 * opaque strings. That refusal is the only qualification check in the whole
 * product and it can say exactly one thing: this list does not contain that
 * string. It cannot say the person holding the certification left in March,
 * or that the licence ran out three weeks ago, because nothing in the schema
 * knew that a skill was a certification, that a certification belongs to a
 * named person, or that it has a date on it.
 *
 * `schema/qualifications.ts` is what makes those strings real. This file is
 * what reads and writes them, and `skillStanding` below is the function the
 * crew check is meant to call.
 *
 * THREE PERMISSIONS, AND THEY ARE DIFFERENT QUESTIONS.
 *
 *   `user:read` is the roster: who works here, what their role is, whether
 *   they are still active. The `office_manager` preset holds it and does not
 *   hold anything compliance, and an office manager is the person who
 *   actually maintains the list of people.
 *
 *   `compliance:read` and `compliance:write` are the certifications. The
 *   catalogue describes them as "View licences, insurance and compliance
 *   records" and "Manage" the same, which is this module named exactly.
 *   `services/inspections.ts` already guards with them.
 *
 * They are NOT interchangeable and the difference is the point: a licence
 * number, an expiry and who verified it are compliance records about a named
 * person, and the roster is a staff list. `office_manager` reads the second
 * and not the first, under the presets as they stand today.
 *
 * NO `person:*` OR `certification:*` PERMISSION IS INVENTED HERE, for the
 * reason `services/crews.ts` sets out at length: the catalogue in
 * `packages/core/src/access/permissions.ts` is the whole of the
 * authorization model, and a string that is not in it cannot be granted to
 * anybody, so a guard naming one is a guard nobody can satisfy.
 *
 * THE SEAM WITH M23 (documents and compliance), which is being built
 * alongside this: these tables hold the PERSON and the QUALIFICATION and
 * never the bytes. There is no file column, no storage key, no document id.
 * The certificate attaches through `attachment` with entity_type
 * `person_certification`, which is the path `services/files.ts` already
 * offers for any entity and which needs nothing from this module. See the
 * header of `schema/qualifications.ts`.
 */

/* ------------------------------------------------------ what we recognise */

export interface CertificationTypeInput {
  code: string;
  name: string;
  authority?: string | null | undefined;
  grantsSkills?: string[] | undefined;
  expires?: boolean | undefined;
  defaultValidMonths?: number | null | undefined;
  renewalLeadDays?: number | undefined;
  /** Continuing education hours a renewal needs, where the authority asks for any. */
  ceHoursRequired?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * Declare a certification this company recognises.
 *
 * A TYPE THAT EXPIRES AND HAS NO WAY TO KNOW WHEN IS REFUSED. `expires` is
 * true by default because almost every trade certification does, and a type
 * declared that way with neither a default validity nor an expiry supplied at
 * recording time produces holdings with a null expiry, which this module
 * reads as "never expires". That is the dangerous direction: every lapsed
 * card in the company would read as current forever, on a screen built to
 * tell somebody when to renew.
 */
export async function defineCertificationType(
  ctx: ServiceContext, input: CertificationTypeInput,
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const code = input.code.trim();
    const name = input.name.trim();
    if (code === "") throw new ConflictError("A certification type needs a code.");
    if (name === "") throw new ConflictError("A certification type needs a name.");

    const lead = input.renewalLeadDays ?? 60;
    if (!Number.isInteger(lead) || lead < 0) {
      throw new ConflictError("Renewal notice is a whole number of days, and not a negative one.");
    }
    const months = input.defaultValidMonths ?? null;
    if (months !== null && (!Number.isInteger(months) || months <= 0)) {
      throw new ConflictError("A default validity is a whole number of months greater than zero.");
    }

    /**
     * Checked here as well as by the unique index, because the index reports
     * a duplicate as a message about `certification_type_code_idx` and the
     * person reading it is an office manager typing in a licence.
     */
    const [clash] = await tx.select({ id: schema.certificationType.id })
      .from(schema.certificationType)
      .where(and(
        eq(schema.certificationType.organizationId, ctx.actor.organizationId),
        eq(schema.certificationType.code, code),
      )).limit(1);
    if (clash) {
      throw new ConflictError(
        `This company already has a certification with the code ${code}. `
        + "Two of them means the skill a job needs is granted by whichever row was read first.",
      );
    }

    const [row] = await tx.insert(schema.certificationType).values({
      organizationId: ctx.actor.organizationId,
      code,
      name,
      authority: input.authority ?? null,
      grantsSkills: normaliseSkills(input.grantsSkills ?? []),
      expires: input.expires ?? true,
      defaultValidMonths: months,
      renewalLeadDays: lead,
      ceHoursRequired: ceHours(input.ceHoursRequired),
      note: input.note ?? null,
    }).returning();

    await audit(tx, ctx, "certification_type.defined", "certification_type", row!.id, null, row!);
    return row!;
  });
}

export interface CertificationTypeUpdate {
  id: string;
  name?: string | undefined;
  authority?: string | null | undefined;
  grantsSkills?: string[] | undefined;
  defaultValidMonths?: number | null | undefined;
  renewalLeadDays?: number | undefined;
  ceHoursRequired?: string | null | undefined;
  note?: string | null | undefined;
  active?: boolean | undefined;
}

/**
 * Change what a certification type is, or retire it.
 *
 * `expires` IS NOT EDITABLE and that is deliberate. Flipping it on a type
 * that already has holdings reinterprets every one of them: the rows whose
 * expiry is null stop meaning "this does not run out" and start meaning
 * "nobody recorded when this ran out", and a dispatch check that cleared this
 * morning refuses this afternoon with no row having changed. A company that
 * got it wrong declares the right type and retires this one, which leaves the
 * old holdings readable and attached to the thing they were recorded under.
 *
 * Retiring is `active = false` rather than a delete, for the same reason:
 * the holdings stay, and so does the answer to "was Dana certified in March".
 */
export async function updateCertificationType(ctx: ServiceContext, input: CertificationTypeUpdate) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const before = await loadType(tx, ctx.actor.organizationId, input.id);

    if (input.renewalLeadDays !== undefined
      && (!Number.isInteger(input.renewalLeadDays) || input.renewalLeadDays < 0)) {
      throw new ConflictError("Renewal notice is a whole number of days, and not a negative one.");
    }
    if (input.defaultValidMonths !== undefined && input.defaultValidMonths !== null
      && (!Number.isInteger(input.defaultValidMonths) || input.defaultValidMonths <= 0)) {
      throw new ConflictError("A default validity is a whole number of months greater than zero.");
    }

    const [row] = await tx.update(schema.certificationType).set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.authority !== undefined ? { authority: input.authority } : {}),
      ...(input.grantsSkills !== undefined ? { grantsSkills: normaliseSkills(input.grantsSkills) } : {}),
      ...(input.defaultValidMonths !== undefined ? { defaultValidMonths: input.defaultValidMonths } : {}),
      ...(input.renewalLeadDays !== undefined ? { renewalLeadDays: input.renewalLeadDays } : {}),
      ...(input.ceHoursRequired !== undefined ? { ceHoursRequired: ceHours(input.ceHoursRequired) } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.certificationType.id, before.id)).returning();

    await audit(tx, ctx, "certification_type.updated", "certification_type", before.id, before, row!);
    return row!;
  });
}

/**
 * Continuing education hours, as hundredths a person can type: "16", "7.5".
 * Zero is stored as none, because a requirement of nothing is no requirement.
 */
function ceHours(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  let hundredths: bigint;
  try { hundredths = peopleCore.hundredths(value); } catch {
    throw new ConflictError(`"${value}" is not a number of hours. Hours go to two decimal places at most.`);
  }
  return hundredths === 0n ? null : peopleCore.hoursLabel(hundredths);
}

/** Trimmed, de-duplicated, and empty strings dropped. A skill of "" matches nothing. */
function normaliseSkills(skills: string[]): string[] {
  return [...new Set(skills.map((s) => s.trim()).filter((s) => s !== ""))];
}

export async function listCertificationTypes(ctx: ServiceContext) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.certificationType)
      .where(eq(schema.certificationType.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.certificationType.code));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      authority: row.authority,
      grantsSkills: row.grantsSkills,
      expires: row.expires,
      defaultValidMonths: row.defaultValidMonths,
      renewalLeadDays: row.renewalLeadDays,
      ceHoursRequired: row.ceHoursRequired === null ? null : peopleCore.hoursLabel(peopleCore.hundredths(row.ceHoursRequired)),
      active: row.active,
      note: row.note,
    }));
  });
}

/* ------------------------------------------------ what a person holds */

export interface CertificationInput {
  technicianId: string;
  certificationTypeId: string;
  reference?: string | null | undefined;
  issuedOn?: string | null | undefined;
  expiresOn?: string | null | undefined;
}

/**
 * Record that somebody holds a certification.
 *
 * RENEWING IS CALLING THIS AGAIN, with the new dates, and the old row stays.
 * See the table comment: "was this person certified on the day they did that
 * work" is the question the row exists to answer, and an expiry that gets
 * overwritten every two years cannot answer it. The current certification is
 * the one with the furthest expiry, which is what `skillStanding` reads.
 *
 * THE EXPIRY AND THE TYPE HAVE TO AGREE, in both directions, and this is the
 * same shape of guard as the production rate and its unit in
 * `services/crews.ts`. A type that does not expire with a date on the holding
 * means somebody will see a renewal reminder for a licence that is good for
 * life. A type that does expire with no date and no default validity means a
 * lapsed card reads as current forever, which is the failure this whole
 * module exists to prevent.
 */
export async function recordCertification(ctx: ServiceContext, input: CertificationInput) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const type = await loadType(tx, ctx.actor.organizationId, input.certificationTypeId);
    if (!type.active) {
      throw new ConflictError(
        `${type.name} has been retired, so nothing new should be recorded against it.`,
      );
    }

    const [technician] = await tx.select({
      id: schema.technician.id, displayName: schema.technician.displayName,
    }).from(schema.technician)
      .where(and(
        eq(schema.technician.id, input.technicianId),
        eq(schema.technician.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!technician) throw new NotFoundError("Technician");

    const issuedOn = input.issuedOn ?? null;
    let expiresOn = input.expiresOn ?? null;

    if (!type.expires && expiresOn !== null) {
      throw new ConflictError(
        `${type.name} is declared as a certification that does not expire, so a date here `
        + "would put it on a renewal list it can never come off.",
      );
    }
    if (type.expires && expiresOn === null) {
      /**
       * Filled in from the type's default validity when there is one, and
       * only when there is an issue date to count from. Counting from today
       * would date the licence from the afternoon somebody typed it in.
       */
      if (type.defaultValidMonths !== null && issuedOn !== null) {
        expiresOn = addMonths(issuedOn, type.defaultValidMonths);
      } else {
        throw new ConflictError(
          `${type.name} expires, so this needs the date it expires on. `
          + "Without it the card reads as current forever and nobody is ever told to renew it.",
        );
      }
    }
    if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn) {
      throw new ConflictError("That certification expires before it was issued.");
    }

    const reference = input.reference?.trim() ?? null;
    if (reference !== null && reference !== "") {
      const [clash] = await tx.select({ id: schema.personCertification.id })
        .from(schema.personCertification)
        .where(and(
          eq(schema.personCertification.technicianId, technician.id),
          eq(schema.personCertification.certificationTypeId, type.id),
          eq(schema.personCertification.reference, reference),
        )).limit(1);
      if (clash) {
        throw new ConflictError(
          `${technician.displayName} already holds ${type.name} under number ${reference}. `
          + "Two rows for one licence means the answer to whether they are current depends on "
          + "which one was read first.",
        );
      }
    }

    const [row] = await tx.insert(schema.personCertification).values({
      organizationId: ctx.actor.organizationId,
      technicianId: technician.id,
      certificationTypeId: type.id,
      reference: reference === "" ? null : reference,
      issuedOn,
      expiresOn,
      status: "active",
    }).returning();

    await audit(tx, ctx, "certification.recorded", "person_certification", row!.id, null, row!);
    return row!;
  });
}

/**
 * Somebody looked at the actual card.
 *
 * A separate call from recording it, because recording is usually an office
 * manager typing from an email and verifying is somebody holding the licence
 * in their hand. A company being audited is asked which of the two happened,
 * and a single `created_at` cannot tell them apart.
 */
export async function verifyCertification(
  ctx: ServiceContext, input: { id: string; note?: string | null | undefined },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const before = await loadCertification(tx, ctx.actor.organizationId, input.id);

    const [row] = await tx.update(schema.personCertification).set({
      verifiedAt: new Date(),
      /**
       * The person who verified it, which is the whole value of the record.
       * `audit` names the actor too, and that is not a substitute: the audit
       * log is a stream nobody reads row by row, and the question asked at an
       * audit is "who signed off on this licence", pointed at this row.
       */
      verifiedByUserId: ctx.actor.userId,
      verificationNote: input.note ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.personCertification.id, before.id)).returning();

    await audit(tx, ctx, "certification.verified", "person_certification", before.id, before, row!);
    return row!;
  });
}

/**
 * Suspend, revoke or reinstate.
 *
 * SEPARATE FROM EXPIRY, which is computed from the date and never stored. A
 * suspended licence may come back and a revoked one will not, and neither is
 * a lapse: the person did not forget to renew, an authority took it off them.
 * `skillStanding` refuses all three and says which it was, because "renew
 * this" and "this person cannot do this work any more" are different
 * instructions to whoever is reading the board.
 */
export async function setCertificationStatus(
  ctx: ServiceContext,
  input: {
    id: string;
    status: typeof schema.certificationStatus.enumValues[number];
    reason?: string | null | undefined;
  },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const before = await loadCertification(tx, ctx.actor.organizationId, input.id);

    if (before.status === "revoked" && input.status !== "revoked") {
      throw new ConflictError(
        "A revoked certification is not reinstated by changing a column. The authority issues "
        + "a new one, and a new one is a new record with its own dates.",
      );
    }
    if (input.status !== "active" && (input.reason ?? "").trim() === "") {
      throw new ConflictError(
        "Say why. A suspension with no reason on it is a refusal nobody downstream can explain "
        + "to the technician it stops.",
      );
    }

    const [row] = await tx.update(schema.personCertification).set({
      status: input.status,
      statusReason: input.status === "active" ? null : (input.reason ?? null),
      updatedAt: new Date(),
    }).where(eq(schema.personCertification.id, before.id)).returning();

    await audit(tx, ctx, "certification.status_set", "person_certification", before.id, before, row!);
    return row!;
  });
}

export interface HeldCertification {
  id: string;
  technicianId: string;
  technicianName: string;
  certificationTypeId: string;
  code: string;
  name: string;
  authority: string | null;
  grantsSkills: string[];
  reference: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: string;
  statusReason: string | null;
  /** Computed against the day asked about. Never a stored column. See the enum. */
  current: boolean;
  /** Why it does not count today, when it does not. Null when it does. */
  lapseReason: "expired" | "suspended" | "revoked" | null;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
}

/**
 * What people hold, optionally narrowed to one of them.
 *
 * Includes the lapsed and the revoked, deliberately. A list that showed only
 * what is current would answer "who can do this today" and would silently
 * lose the record that somebody's licence was pulled, which is the row a
 * compliance officer is looking for.
 */
export async function listCertifications(
  ctx: ServiceContext,
  input: { technicianId?: string | undefined; on?: string | undefined } = {},
): Promise<HeldCertification[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const on = input.on ?? time.dateIn(new Date(), zone);
    return held(tx, ctx.actor.organizationId, {
      ...(input.technicianId !== undefined ? { technicianIds: [input.technicianId] } : {}),
      on,
    });
  });
}

/** The read both the list and the standing check run, with the lapse decided once. */
export async function held(
  tx: Database, organizationId: string,
  input: { technicianIds?: string[] | undefined; typeIds?: string[] | undefined; on: string },
): Promise<HeldCertification[]> {
  if (input.technicianIds?.length === 0) return [];
  if (input.typeIds?.length === 0) return [];

  const rows = await tx.select({
    id: schema.personCertification.id,
    technicianId: schema.personCertification.technicianId,
    technicianName: schema.technician.displayName,
    certificationTypeId: schema.personCertification.certificationTypeId,
    code: schema.certificationType.code,
    name: schema.certificationType.name,
    authority: schema.certificationType.authority,
    grantsSkills: schema.certificationType.grantsSkills,
    reference: schema.personCertification.reference,
    issuedOn: schema.personCertification.issuedOn,
    expiresOn: schema.personCertification.expiresOn,
    status: schema.personCertification.status,
    statusReason: schema.personCertification.statusReason,
    verifiedAt: schema.personCertification.verifiedAt,
    verifiedByUserId: schema.personCertification.verifiedByUserId,
  }).from(schema.personCertification)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.personCertification.technicianId))
    .innerJoin(
      schema.certificationType,
      eq(schema.certificationType.id, schema.personCertification.certificationTypeId),
    )
    .where(and(
      eq(schema.personCertification.organizationId, organizationId),
      input.technicianIds
        ? inArray(schema.personCertification.technicianId, input.technicianIds) : undefined,
      input.typeIds
        ? inArray(schema.personCertification.certificationTypeId, input.typeIds) : undefined,
    ))
    .orderBy(asc(schema.technician.displayName), asc(schema.certificationType.code));

  return rows.map((row) => {
    const lapseReason = lapse(row.status, row.expiresOn, input.on);
    return { ...row, current: lapseReason === null, lapseReason };
  });
}

/**
 * Why this certification does not count on this day, or null when it does.
 *
 * A DATE COMPARISON ON STRINGS, which is correct here and only because both
 * sides are ISO calendar dates in the same format. `expires_on` is a
 * `date` column and comes back as "2026-03-14"; `on` is produced by
 * `time.dateIn` in the company's own zone. Comparing those as strings is the
 * same ordering as comparing them as dates, and it avoids turning a calendar
 * date into an instant, which is how an expiry moves a day for half the
 * country twice a year.
 *
 * THE DAY IT EXPIRES IS STILL A DAY IT IS VALID. A licence that expires on
 * the 14th is good on the 14th and not on the 15th, which is how every
 * authority this was checked against words it.
 */
function lapse(
  status: string, expiresOn: string | null, on: string,
): "expired" | "suspended" | "revoked" | null {
  if (status === "revoked") return "revoked";
  if (status === "suspended") return "suspended";
  if (expiresOn !== null && expiresOn < on) return "expired";
  return null;
}

/** Calendar months, clamped to the end of a short month. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new ConflictError(`${date} is not a calendar date.`);
  }
  const target = m - 1 + months;
  const year = y + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  /**
   * Day zero of the next month is the last day of this one. A licence issued
   * on the 31st of January and valid for a month expires on the 28th, not on
   * the 3rd of March, which is what rolling over would give.
   */
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/* ------------------------------------------------------- the renewal list */

export interface ExpiringCertification extends HeldCertification {
  /** Negative once it has already gone. */
  daysRemaining: number;
  /** The type's own notice period, which is what put this row on the list. */
  renewalLeadDays: number;
}

/**
 * WHAT IS ABOUT TO RUN OUT, AND WHAT ALREADY HAS.
 *
 * The window is per certification type by default rather than one number for
 * the company, because the notice period is a property of the certification:
 * a licence whose renewal takes a day of paperwork and one that takes six
 * weeks of continuing education do not want the same warning. `within` is
 * there for the screen that asks "what is coming up in the next thirty days"
 * regardless of type.
 *
 * ALREADY EXPIRED ROWS ARE INCLUDED AND FLAGGED. A renewal list that drops a
 * certification the moment it lapses is a list that is empty exactly when
 * somebody needed to look at it.
 */
export async function expiringSoon(
  ctx: ServiceContext, input: { within?: number | undefined } = {},
): Promise<ExpiringCertification[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);

    const rows = await tx.select({
      certification: schema.personCertification,
      type: schema.certificationType,
      technicianName: schema.technician.displayName,
    }).from(schema.personCertification)
      .innerJoin(
        schema.certificationType,
        eq(schema.certificationType.id, schema.personCertification.certificationTypeId),
      )
      .innerJoin(schema.technician, eq(schema.technician.id, schema.personCertification.technicianId))
      .where(and(
        eq(schema.personCertification.organizationId, ctx.actor.organizationId),
        isNotNull(schema.personCertification.expiresOn),
        /**
         * Revoked rows are left out and suspended ones are not. A revoked
         * certification is not renewed, it is reissued as a new record, so a
         * renewal reminder for one is an instruction nobody can carry out.
         * A suspension can be lifted and the expiry still matters.
         */
        inArray(schema.personCertification.status, ["active", "suspended"]),
      ))
      .orderBy(asc(schema.personCertification.expiresOn));

    const out: ExpiringCertification[] = [];
    for (const row of rows) {
      const expiresOn = row.certification.expiresOn;
      if (expiresOn === null) continue;
      const remaining = daysBetween(today, expiresOn);
      const window = input.within ?? row.type.renewalLeadDays;
      if (remaining > window) continue;

      const lapseReason = lapse(row.certification.status, expiresOn, today);
      out.push({
        id: row.certification.id,
        technicianId: row.certification.technicianId,
        technicianName: row.technicianName,
        certificationTypeId: row.type.id,
        code: row.type.code,
        name: row.type.name,
        authority: row.type.authority,
        grantsSkills: row.type.grantsSkills,
        reference: row.certification.reference,
        issuedOn: row.certification.issuedOn,
        expiresOn,
        status: row.certification.status,
        statusReason: row.certification.statusReason,
        current: lapseReason === null,
        lapseReason,
        verifiedAt: row.certification.verifiedAt,
        verifiedByUserId: row.certification.verifiedByUserId,
        daysRemaining: remaining,
        renewalLeadDays: row.type.renewalLeadDays,
      });
    }
    return out;
  });
}

/** Whole days between two ISO calendar dates, counted in UTC so no zone shifts them. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/* ------------------------------------------- is this work covered, and by whom */

export type SkillState = "covered" | "lapsed" | "absent" | "uncertified";

export interface SkillStanding {
  skill: string;
  state: SkillState;
  /** A sentence a dispatcher can act on. Names the person and the date. */
  explanation: string;
  /** Every certification bearing on this skill, held by the people asked about. */
  evidence: HeldCertification[];
}

/**
 * CAN THESE PEOPLE DO THIS WORK, AND IF NOT, WHY NOT.
 *
 * This is the function M24 exists to give `services/crews.ts`. That file
 * computes `missingSkills` as a set difference between `crew.skills` and
 * `job_type.required_skills` and reports "not qualified for epa_608", which
 * is true and useless: the dispatcher cannot tell whether nobody ever had it,
 * whether the person who had it left, or whether it ran out last month, and
 * those have three different answers this morning.
 *
 * FOUR STATES, AND THE FOURTH IS THE HONEST ONE.
 *
 *   `covered`      somebody in this group holds a live certification for it.
 *   `lapsed`       a certification for it exists and none of them counts
 *                  today. The explanation names whose and why.
 *   `absent`       this company recognises a certification for this skill and
 *                  nobody in this group holds one at all.
 *   `uncertified`  no certification type in this company grants this skill,
 *                  so THIS MODULE HAS NOTHING TO SAY ABOUT IT. It is not a
 *                  clearance. The opaque string check in `crews.ts` is still
 *                  the only thing that knows anything, and a caller that read
 *                  this as "fine" would turn an unmapped skill into a pass.
 *
 * That last distinction is the same one `crews.ts` makes with
 * `equipmentBasis`, for the same reason: an empty list of problems is a
 * statement about the data and not about the people.
 *
 * A TRANSACTION RATHER THAN A CONTEXT, so a service that is already inside
 * one can call it. `services/billing.ts` sets out the rule this follows: a
 * service never calls another service's public entry point from inside a
 * transaction, it calls a loader that takes the transaction it is already in.
 * The caller's own guard is what authorizes the read; `standingFor` below is
 * the guarded entry point for anybody calling from outside.
 */
export async function skillStanding(
  tx: Database,
  organizationId: string,
  input: { technicianIds: string[]; skills: string[]; on: string },
): Promise<SkillStanding[]> {
  const skills = normaliseSkills(input.skills);
  if (skills.length === 0) return [];

  /**
   * Active types only. A retired certification type is one this company no
   * longer recognises, so a holding of it should not clear work today; the
   * holding itself stays readable through `listCertifications`.
   */
  const types = await tx.select({
    id: schema.certificationType.id,
    grantsSkills: schema.certificationType.grantsSkills,
  }).from(schema.certificationType)
    .where(and(
      eq(schema.certificationType.organizationId, organizationId),
      eq(schema.certificationType.active, true),
    ));

  const typesForSkill = new Map<string, string[]>();
  for (const skill of skills) {
    const matching = types.filter((t) => t.grantsSkills.includes(skill)).map((t) => t.id);
    if (matching.length > 0) typesForSkill.set(skill, matching);
  }

  const relevantTypeIds = [...new Set([...typesForSkill.values()].flat())];
  const holdings = relevantTypeIds.length === 0 || input.technicianIds.length === 0
    ? []
    : await held(tx, organizationId, {
      technicianIds: input.technicianIds,
      typeIds: relevantTypeIds,
      on: input.on,
    });

  return skills.map((skill) => {
    const typeIds = typesForSkill.get(skill);
    if (!typeIds) {
      return {
        skill,
        state: "uncertified" as const,
        explanation:
          `No certification in this company grants ${skill}, so nothing here can say whether `
          + "anybody is qualified for it. Declare a certification type that grants it to make "
          + "this answerable.",
        evidence: [],
      };
    }

    const evidence = holdings.filter((h) => typeIds.includes(h.certificationTypeId));
    if (evidence.length === 0) {
      return {
        skill,
        state: "absent" as const,
        explanation: `Nobody here holds a certification for ${skill}.`,
        evidence: [],
      };
    }

    const live = evidence.filter((h) => h.current);
    if (live.length > 0) {
      return {
        skill,
        state: "covered" as const,
        explanation: `${live.map((h) => `${h.technicianName} holds ${h.name}`).join(", ")}.`,
        evidence,
      };
    }

    /**
     * The sentence this whole module was built to be able to say. It names
     * the person, the certification and the date, because every one of those
     * is needed to do something about it before the truck leaves.
     */
    return {
      skill,
      state: "lapsed" as const,
      explanation: evidence.map((h) => {
        if (h.lapseReason === "expired") {
          return `${h.technicianName}'s ${h.name} expired on ${h.expiresOn ?? "an unrecorded date"}`;
        }
        if (h.lapseReason === "suspended") {
          return `${h.technicianName}'s ${h.name} is suspended`;
        }
        return `${h.technicianName}'s ${h.name} has been revoked`;
      }).join(", ") + `, so nobody here can take ${skill} work today.`,
      evidence,
    };
  });
}

/**
 * The guarded entry point for the same question, for a caller outside a
 * transaction: a settings screen, or an office manager checking before
 * committing to a date.
 */
export async function standingFor(
  ctx: ServiceContext,
  input: { technicianIds: string[]; skills: string[]; on?: string | undefined },
): Promise<{ on: string; standing: SkillStanding[] }> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const on = input.on ?? time.dateIn(new Date(), zone);
    return {
      on,
      standing: await skillStanding(tx, ctx.actor.organizationId, {
        technicianIds: input.technicianIds,
        skills: input.skills,
        on,
      }),
    };
  });
}

/* ------------------------------------------------------------- the roster */

export interface Person {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: string;
  active: boolean;
  technicianId: string | null;
  displayName: string | null;
  technicianActive: boolean | null;
  /** The technician's own fields, or null for somebody who is not one. */
  customFields: Record<string, unknown> | null;
}

/**
 * WHO WORKS HERE.
 *
 * Guarded by `user:read`, which the catalogue calls "View users" and which
 * nothing in this product checked before this module. It was excused in
 * `test/permissions-enforced.test.ts` as owed by M01 on the grounds that the
 * settings screen listed members under a different permission; this is the
 * surface it names, so that excuse is gone.
 *
 * NAMES AND EMAILS THROUGH A FUNCTION, NOT A JOIN. `public."user"` carries
 * a row level security policy that returns a user's own row and nothing
 * else, so a join to it from here returned one address, the caller's own.
 * `app.organization_people()` answers for this company's members only, with
 * the name and address a colleague already sees on the schedule. Without
 * them a migration matching technicians by email had nothing to match on.
 *
 * NO `technician.skills` EITHER, AND THAT ONE IS A FINDING RATHER THAN A
 * DESIGN. The column exists, `services/crews.ts` has a comment calling skills
 * and licences the thing that gates dispatch assignment, and NOTHING IN THIS
 * PRODUCT HAS EVER WRITTEN IT: the crew's own `skills` array is written by
 * `crews.create`, the technician's is not written anywhere. Returning it here
 * would put an empty array on every person on a roster screen and teach
 * whoever read it that nobody in the company is qualified for anything.
 * `technician.licenses` is in the same state and these tables replace it.
 *
 * NO CERTIFICATIONS HERE EITHER, and that is the permission boundary rather
 * than an omission. A licence number and an expiry against a named person is
 * a compliance record; `office_manager` holds `user:read` and does not hold
 * `compliance:read`. Hanging the certifications off this read would hand
 * every holder of the staff list the compliance file with it.
 */
export async function listPeople(
  ctx: ServiceContext,
  input: { email?: string | undefined; fieldKey?: string | undefined; fieldValue?: string | undefined } = {},
): Promise<Person[]> {
  return guardedRead(ctx, "user:read", async (tx) => {
    const directory = await tx.execute<{ membership_id: string; name: string | null; email: string }>(
      sql`select membership_id, name, email from app.organization_people()`,
    );
    const byMembership = new Map(directory.map((d) => [d.membership_id, d]));
    const wanted = input.email?.toLowerCase();

    const rows = await tx.select({
      membershipId: schema.membership.id,
      userId: schema.membership.userId,
      role: schema.membership.role,
      active: schema.membership.active,
      technicianId: schema.technician.id,
      displayName: schema.technician.displayName,
      technicianActive: schema.technician.active,
      customFields: schema.technician.customFields,
    }).from(schema.membership)
      .leftJoin(schema.technician, eq(schema.technician.membershipId, schema.membership.id))
      .where(and(
        eq(schema.membership.organizationId, ctx.actor.organizationId),
        await listFilter(tx, ctx.actor.organizationId, "technician", input, sql`${schema.technician.customFields}`),
      ))
      .orderBy(asc(schema.membership.createdAt));

    return rows.map((row) => ({
      membershipId: row.membershipId,
      userId: row.userId,
      name: byMembership.get(row.membershipId)?.name ?? null,
      email: byMembership.get(row.membershipId)?.email ?? "",
      role: row.role,
      active: row.active,
      technicianId: row.technicianId,
      displayName: row.displayName,
      technicianActive: row.technicianActive,
      customFields: row.customFields,
    })).filter((person) => wanted === undefined || person.email.toLowerCase() === wanted);
  });
}

/**
 * The people on the settings screen: each active membership with its name,
 * address, the role deciding for it and any scope it is narrowed to.
 *
 * The settings screen used to build this by joining `membership` to
 * `public."user"`, and that table's row level security returns a user's own
 * row and nothing else, so the inner join dropped every colleague and an
 * owner opening settings saw a company of one: themselves. Names come
 * through `app.organization_people()` instead, the same path `listPeople`
 * reads, and the policy on the user table stays as tight as it was.
 */
export async function members(ctx: ServiceContext) {
  return guardedRead(ctx, "user:read", async (tx) => {
    const directory = await tx.execute<{ membership_id: string; name: string | null; email: string }>(
      sql`select membership_id, name, email from app.organization_people()`,
    );
    const byMembership = new Map(directory.map((d) => [d.membership_id, d]));

    const rows = await tx.select({
      membership: schema.membership,
      roleName: schema.role.name,
    })
      .from(schema.membership)
      .leftJoin(schema.role, and(
        eq(schema.role.id, schema.membership.roleId),
        isNull(schema.role.deletedAt),
      ))
      .where(and(
        eq(schema.membership.organizationId, ctx.actor.organizationId),
        eq(schema.membership.active, true),
      ))
      .orderBy(asc(schema.membership.createdAt));

    return rows.map(({ membership, roleName }) => ({
      membership,
      roleName,
      name: byMembership.get(membership.id)?.name ?? null,
      email: byMembership.get(membership.id)?.email ?? "",
    }));
  });
}

/* ----------------------------------------------------------------- loading */

/**
 * NO SOFT DELETE FILTER ON EITHER TABLE, AND THAT IS A DECISION.
 *
 * Both carry a `deleted_at` column because every table in this schema does,
 * and nothing in this module sets one: a certification type is retired with
 * `active`, and a holding is suspended or revoked with `status`. Both of
 * those are columns something writes.
 *
 * `test/unwritten-columns.test.ts` makes the argument at length. A filter on
 * a column nothing sets is decoration: it makes a query look guarded when it
 * is not, and it is indistinguishable in review from one that is doing work.
 * `services/crews.ts` reached the same conclusion on its own tables. The day
 * one of these gets a real delete, the filter goes in beside it.
 */
async function loadType(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.certificationType)
    .where(and(
      eq(schema.certificationType.id, id),
      eq(schema.certificationType.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Certification type");
  return row;
}

async function loadCertification(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.personCertification)
    .where(and(
      eq(schema.personCertification.id, id),
      eq(schema.personCertification.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Certification");
  return row;
}

/* --------------------------------------------------------------- handlers */

/**
 * The shapes the route registry wires to, written out rather than inferred,
 * for the reason `services/crews.ts` gives: an explicit return type means a
 * change to a service's shape that breaks the published contract is a compile
 * error here rather than a response that no longer matches the document
 * generated from it.
 */
export const handlers = {
  listPeople: async (ctx: ServiceContext, input: { email?: string | undefined }): Promise<{ people: Person[] }> =>
    ({ people: await listPeople(ctx, input) }),

  listCertificationTypes: async (ctx: ServiceContext): Promise<{
    types: {
      id: string; code: string; name: string; authority: string | null;
      grantsSkills: string[]; expires: boolean; defaultValidMonths: number | null;
      renewalLeadDays: number; ceHoursRequired: string | null; active: boolean; note: string | null;
    }[];
  }> => ({ types: await listCertificationTypes(ctx) }),

  defineCertificationType: async (ctx: ServiceContext, input: CertificationTypeInput): Promise<{
    id: string; code: string; name: string; expires: boolean; active: boolean;
  }> => {
    const row = await defineCertificationType(ctx, input);
    return { id: row.id, code: row.code, name: row.name, expires: row.expires, active: row.active };
  },

  updateCertificationType: async (ctx: ServiceContext, input: CertificationTypeUpdate): Promise<{
    id: string; code: string; name: string; expires: boolean; active: boolean;
  }> => {
    const row = await updateCertificationType(ctx, input);
    return { id: row.id, code: row.code, name: row.name, expires: row.expires, active: row.active };
  },

  listCertifications: async (ctx: ServiceContext, input: {
    technicianId?: string | undefined; on?: string | undefined;
  }): Promise<{ certifications: HeldCertification[] }> =>
    ({ certifications: await listCertifications(ctx, input) }),

  recordCertification: async (ctx: ServiceContext, input: CertificationInput): Promise<{
    id: string; technicianId: string; certificationTypeId: string;
    issuedOn: string | null; expiresOn: string | null; status: string;
  }> => {
    const row = await recordCertification(ctx, input);
    return {
      id: row.id, technicianId: row.technicianId, certificationTypeId: row.certificationTypeId,
      issuedOn: row.issuedOn, expiresOn: row.expiresOn, status: row.status,
    };
  },

  verifyCertification: async (ctx: ServiceContext, input: {
    id: string; note?: string | null | undefined;
  }): Promise<{ id: string; verifiedAt: Date; verifiedByUserId: string | null }> => {
    const row = await verifyCertification(ctx, input);
    /**
     * `verified_at` is nullable on the table and is never null on the way out
     * of this call, because this call is what sets it. Stated as a non-null
     * type so a caller does not write a branch that cannot happen.
     */
    return { id: row.id, verifiedAt: row.verifiedAt!, verifiedByUserId: row.verifiedByUserId };
  },

  setCertificationStatus: async (ctx: ServiceContext, input: {
    id: string;
    status: typeof schema.certificationStatus.enumValues[number];
    reason?: string | null | undefined;
  }): Promise<{ id: string; status: string; statusReason: string | null }> => {
    const row = await setCertificationStatus(ctx, input);
    return { id: row.id, status: row.status, statusReason: row.statusReason };
  },

  listExpiringCertifications: async (ctx: ServiceContext, input: {
    within?: number | undefined;
  }): Promise<{ expiring: ExpiringCertification[] }> =>
    ({ expiring: await expiringSoon(ctx, input) }),

  getSkillStanding: (ctx: ServiceContext, input: {
    technicianIds: string[]; skills: string[]; on?: string | undefined;
  }): Promise<{ on: string; standing: SkillStanding[] }> => standingFor(ctx, input),
} as const;
