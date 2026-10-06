import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, retention as rules, SYSTEM_USER_ID, isSystem, time } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import { emptied } from "./files";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, UnprocessableError,
  type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";

/**
 * ACTING ON RETENTION POLICIES
 *
 * The trade packs have seeded retention rules since the first compliance
 * migration and nothing acted on one: the module doc said "nothing purges on
 * them yet". This is the purge, and it is shaped around the fact that it is
 * the one job in the product that destroys records on its own.
 *
 * FOUR THINGS STAND BETWEEN A RECORD AND THE PURGE, and all four have to say
 * yes.
 *
 *   The company switched purging ON for the rule. Every seeded rule arrives
 *   with it off (`purge_allowed` defaults false), so installing a trade pack
 *   deletes nothing, ever, until somebody here reads the rule and decides.
 *
 *   The record's clock has run out, worked out by core's `judge`, which keeps
 *   a record whenever the clock cannot be worked out.
 *
 *   No other active rule covering the record says to keep it longer, or to
 *   never purge. Where two rules cover one record the longer one wins and a
 *   rule with purging off wins outright, because the cheap way to be wrong
 *   here is keeping something a little longer.
 *
 *   Nobody has put a hold on it.
 *
 * A PREVIEW COMES FIRST, from the same function the purge uses, so what the
 * screen says would go is what goes. And every record removed leaves one
 * audit line naming the rule, the clock and the date it became due, so "where
 * did the 2019 incident reports go" has an answer that is not a shrug.
 *
 * WHAT IT CAN ACT ON. Only record types this product holds and knows how to
 * remove whole: incident reports, toolbox talks, service reports,
 * inspections, a job's photographs and lead form submissions. A rule about
 * anything else (a disposal ticket, a key custody log, a timesheet, an
 * agreement) is shown in the preview as one this product cannot act on,
 * rather than silently matching nothing. Call recordings are deleted by the
 * recordings sweep, which honours the same holds.
 *
 * WHY THE OTHERS DO NOTHING. A kind is added here only when removing it is
 * both safe and complete: nothing else in the product reads it as evidence
 * of money, and everything that is only its own (its photographs, its
 * signatures) goes with it, through the file store. A timesheet is what
 * somebody was paid from, an agreement and a rate card are what an invoice
 * was priced from, and equipment is what a warranty and a service history
 * point at; removing any of those would leave the ledger or an invoice
 * describing something that is no longer there, so they are kept on file
 * and acted on by nothing. Nothing in the ledger or on an invoice is ever
 * removed by this file.
 */

type Facts = rules.ClockFacts;

interface Candidate {
  id: string;
  /** How the preview names it to a person. */
  label: string;
  kind: string | null;
  facts: Facts;
  /** A reason this record is never purged whatever the clock says, like an incident still open. */
  keep?: string | undefined;
}

interface Adapter {
  /** In the words the retention screen uses. */
  label: string;
  /** The table a hold's record id is looked for in. For a job's photographs, the job. */
  table: string;
  /** How a record's kind is decided, said plainly; null when this type has no kinds. */
  kindRule: string | null;
  /** `zone` is the company's, for the day a record is labelled with. */
  candidates: (tx: Database, limit: number, zone: string) => Promise<Candidate[]>;
  /** Remove one record and everything that is only its own. Returns what the audit line keeps of it. */
  purge: (tx: Database, ctx: ServiceContext, id: string) => Promise<Record<string, unknown>>;
}

/** The most records one pass looks at per type, oldest first. The next pass carries on. */
const CANDIDATE_LIMIT = 2000;
/** The most records one pass removes, so a first run over years of history cannot hold a transaction for an hour. */
const PURGE_LIMIT = 500;

/**
 * Let go of a record's files. The attachment row is marked deleted, the
 * stored file's reference count drops, and the bytes are emptied when nothing
 * points at them any more, the same way a deleted call recording's are.
 */
async function releaseAttachments(
  tx: Database, organizationId: string, entityType: string, entityIds: string[], kind?: string | undefined,
) {
  if (entityIds.length === 0) return 0;
  const rows = await tx.update(schema.attachment)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.attachment.entityType, entityType),
      inArray(schema.attachment.entityId, entityIds),
      isNull(schema.attachment.deletedAt),
      kind ? eq(schema.attachment.kind, kind) : undefined,
    ))
    .returning({ storageKey: schema.attachment.storageKey });
  for (const row of rows) {
    await tx.update(schema.storedFile)
      .set({ references: sql`greatest(${schema.storedFile.references} - 1, 0)`, updatedAt: new Date() })
      .where(and(eq(schema.storedFile.organizationId, organizationId), eq(schema.storedFile.storageKey, row.storageKey)));
    await tx.update(schema.storedFile)
      .set(emptied())
      .where(and(
        eq(schema.storedFile.organizationId, organizationId),
        eq(schema.storedFile.storageKey, row.storageKey),
        eq(schema.storedFile.references, 0),
        isNull(schema.storedFile.deletedAt),
      ));
  }
  return rows.length;
}

/**
 * Tasks that pointed at a removed record keep their history and lose the
 * link, because a follow up that was done is still something that was done,
 * and a link to a record that is gone is a dead end on the task screen.
 */
async function unlinkTasks(tx: Database, entityType: string, entityId: string) {
  const rows = await tx.update(schema.task).set({ entityType: null, entityId: null, updatedAt: new Date() })
    .where(and(eq(schema.task.entityType, entityType), eq(schema.task.entityId, entityId)))
    .returning({ id: schema.task.id });
  return rows.map((row) => row.id);
}

/** The company's calendar day of an instant, for a label: a toolbox talk held at 7pm in Austin was held that day. */
const day = (value: Date | null, zone: string) => (value ? time.dateIn(value, zone) : "no date");

/** The trade pack's own code for an inspection programme, which is what a retention rule names it by. */
function programCode(program: { name: string; tradePackId: string | null } | null): string | null {
  if (!program?.tradePackId) return null;
  const pack = packById(program.tradePackId.split("@")[0]!);
  return pack?.inspectionPrograms.find((p) => p.name === program.name)?.code ?? null;
}

export const ADAPTERS: Record<string, Adapter> = {
  incident_report: {
    label: "Incident reports",
    table: "incident_report",
    kindRule: "Its kind: injury, near_miss, property_damage, vehicle, environmental or other.",
    candidates: async (tx, limit, zone) => {
      const rows = await tx.select().from(schema.incidentReport)
        .orderBy(asc(schema.incidentReport.occurredAt)).limit(limit);
      return rows.map((row) => ({
        id: row.id,
        label: `${row.kind.replace("_", " ")} on ${day(row.occurredAt, zone)}`,
        kind: row.kind,
        facts: { createdAt: row.createdAt, recordDate: row.occurredAt, reportPreparedAt: row.closedAt },
        keep: row.status === "open" ? "Kept: the report is still open." : undefined,
      }));
    },
    purge: async (tx, ctx, id) => {
      const [row] = await tx.select().from(schema.incidentReport).where(eq(schema.incidentReport.id, id)).limit(1);
      if (!row) throw new NotFoundError("Incident report");
      const photos = await releaseAttachments(tx, ctx.actor.organizationId, "incident_report", [id]);
      const tasks = await unlinkTasks(tx, "incident_report", id);
      await tx.delete(schema.incidentReport).where(eq(schema.incidentReport.id, id));
      return { kind: row.kind, occurredAt: row.occurredAt, status: row.status, photos, unlinkedTasks: tasks };
    },
  },
  safety_meeting: {
    label: "Toolbox talks",
    table: "safety_meeting",
    kindRule: null,
    candidates: async (tx, limit, zone) => {
      const rows = await tx.select().from(schema.safetyMeeting).orderBy(asc(schema.safetyMeeting.heldAt)).limit(limit);
      return rows.map((row) => ({
        id: row.id,
        label: `"${row.topic}" on ${day(row.heldAt, zone)}`,
        kind: null,
        facts: { createdAt: row.createdAt, recordDate: row.heldAt, reportPreparedAt: row.closedAt },
      }));
    },
    purge: async (tx, ctx, id) => {
      const [row] = await tx.select().from(schema.safetyMeeting).where(eq(schema.safetyMeeting.id, id)).limit(1);
      if (!row) throw new NotFoundError("Toolbox talk");
      const attendees = await tx.select({ id: schema.safetyMeetingAttendee.id }).from(schema.safetyMeetingAttendee)
        .where(eq(schema.safetyMeetingAttendee.meetingId, id));
      const signatures = await releaseAttachments(
        tx, ctx.actor.organizationId, "safety_meeting_attendee", attendees.map((a) => a.id),
      );
      const photos = await releaseAttachments(tx, ctx.actor.organizationId, "safety_meeting", [id]);
      await tx.delete(schema.safetyMeeting).where(eq(schema.safetyMeeting.id, id));
      return { topic: row.topic, heldAt: row.heldAt, attendees: attendees.length, signatures, photos };
    },
  },
  service_report: {
    label: "Service reports",
    table: "service_report",
    kindRule: "The code of the job type on its job, such as drain or panel.",
    candidates: async (tx, limit, zone) => {
      const rows = await tx.select({
        report: schema.serviceReport, completedAt: schema.job.completedAt, typeCode: schema.jobType.code,
      }).from(schema.serviceReport)
        .innerJoin(schema.job, eq(schema.job.id, schema.serviceReport.jobId))
        .leftJoin(schema.jobType, eq(schema.jobType.id, schema.job.jobTypeId))
        .orderBy(asc(schema.serviceReport.createdAt)).limit(limit);
      return rows.map(({ report, completedAt, typeCode }) => ({
        id: report.id,
        label: `Report from ${day(report.createdAt, zone)}${typeCode ? ` (${typeCode})` : ""}`,
        kind: typeCode,
        facts: {
          createdAt: report.createdAt, recordDate: report.createdAt,
          reportPreparedAt: report.submittedAt, workCompletedAt: completedAt,
        },
      }));
    },
    purge: async (tx, ctx, id) => {
      const [row] = await tx.select().from(schema.serviceReport).where(eq(schema.serviceReport.id, id)).limit(1);
      if (!row) throw new NotFoundError("Service report");
      const photos = await releaseAttachments(tx, ctx.actor.organizationId, "service_report", [id]);
      await tx.delete(schema.serviceReport).where(eq(schema.serviceReport.id, id));
      return { jobId: row.jobId, visitId: row.visitId, createdAt: row.createdAt, photos };
    },
  },
  inspection: {
    label: "Inspections",
    table: "inspection",
    kindRule: "The trade pack's code for its inspection programme, such as backflow-annual.",
    candidates: async (tx, limit) => {
      const rows = await tx.select({
        inspection: schema.inspection,
        programName: schema.inspectionProgram.name,
        programPack: schema.inspectionProgram.tradePackId,
      }).from(schema.inspection)
        .leftJoin(schema.inspectionProgram, eq(schema.inspectionProgram.id, schema.inspection.programId))
        .orderBy(asc(schema.inspection.createdAt)).limit(limit);

      /**
       * Every performed date per address and programme, for the clock that
       * runs from the NEXT inspection of the same kind at the same place. Read
       * whole and matched here rather than as a correlated subquery, because
       * the next one is usually newer than anything in the oldest first window
       * above, and a subquery's outer reference is one rendering away from
       * comparing a table to itself.
       */
      const performedDates = await tx.select({
        propertyId: schema.inspection.propertyId,
        programId: schema.inspection.programId,
        performedOn: schema.inspection.performedOn,
      }).from(schema.inspection).where(sql`${schema.inspection.performedOn} is not null`);
      const byPlace = new Map<string, string[]>();
      for (const row of performedDates) {
        const place = `${row.propertyId}|${row.programId ?? ""}`;
        const list = byPlace.get(place) ?? [];
        list.push(row.performedOn!);
        byPlace.set(place, list);
      }
      const nextAfter = (propertyId: string, programId: string | null, on: string | null): string | null => {
        if (!on) return null;
        const later = (byPlace.get(`${propertyId}|${programId ?? ""}`) ?? []).filter((date) => date > on).sort();
        return later[0] ?? null;
      };

      return rows.map(({ inspection, programName, programPack }) => {
        const nextOn = nextAfter(inspection.propertyId, inspection.programId, inspection.performedOn);
        const performed = inspection.performedOn ? new Date(`${inspection.performedOn}T12:00:00Z`) : null;
        return {
          id: inspection.id,
          label: `${programName ?? "Inspection"} performed ${inspection.performedOn ?? "on no recorded date"}`,
          kind: programCode(programName ? { name: programName, tradePackId: programPack } : null),
          facts: {
            createdAt: inspection.createdAt,
            recordDate: performed,
            reportPreparedAt: inspection.submittedAt ?? performed,
            workCompletedAt: performed,
            nextActivityAt: nextOn ? new Date(`${nextOn}T12:00:00Z`) : null,
          },
        };
      });
    },
    purge: async (tx, ctx, id) => {
      const [row] = await tx.select().from(schema.inspection).where(eq(schema.inspection.id, id)).limit(1);
      if (!row) throw new NotFoundError("Inspection");
      const photos = await releaseAttachments(tx, ctx.actor.organizationId, "inspection", [id]);
      await tx.delete(schema.inspection).where(eq(schema.inspection.id, id));
      return { propertyId: row.propertyId, performedOn: row.performedOn, result: row.result, photos };
    },
  },
  /**
   * A JOB'S PHOTOGRAPHS, as one record held and removed together: every
   * photograph on the job and on its visits. The job, its visits, its
   * invoices and its service reports stay. A signature on a visit is not a
   * photograph (it is what a customer signed an estimate or an invoice with)
   * and is never removed. A photograph an invoice or an estimate also shows
   * is a second attachment pointing at the same stored file, so the file
   * stays until nothing points at it.
   *
   * Kept whatever the clock says while the job is not finished, and while an
   * invoice on it is still owed, because those are the two moments somebody
   * reaches for the pictures.
   */
  photo: {
    label: "A job's photographs",
    table: "job",
    kindRule: "The code of the job type on the job, such as drain or panel.",
    candidates: async (tx, limit, zone) => {
      const rows = await tx.execute<{
        id: string; number: number; status: string; created_at: Date; completed_at: Date | null;
        type_code: string | null; owed: boolean;
      }>(sql`
        select j.id, j.number, j.status, j.created_at, j.completed_at, t.code as type_code,
          exists (
            select 1 from public.invoice i
            where i.job_id = j.id and i.deleted_at is null
              and i.status in ('open', 'partially_paid') and i.balance > 0
          ) as owed
        from public.job j
        left join public.job_type t on t.id = j.job_type_id
        where exists (
          select 1 from public.attachment a
          where a.deleted_at is null and a.kind = 'photo'
            and ((a.entity_type = 'job' and a.entity_id = j.id)
              or (a.entity_type = 'visit' and a.entity_id in (select v.id from public.visit v where v.job_id = j.id)))
        )
        order by j.created_at asc
        limit ${limit}`);
      return [...rows].map((row) => {
        const createdAt = new Date(row.created_at);
        const completedAt = row.completed_at ? new Date(row.completed_at) : null;
        const finished = ["completed", "invoiced", "paid", "cancelled"].includes(row.status);
        return {
          id: row.id,
          label: `Photographs on job ${row.number}, ${completedAt ? `finished ${day(completedAt, zone)}` : `opened ${day(createdAt, zone)}`}${row.type_code ? ` (${row.type_code})` : ""}`,
          kind: row.type_code,
          facts: { createdAt, recordDate: completedAt ?? createdAt, workCompletedAt: completedAt },
          keep: !finished ? "Kept: the job is not finished."
            : row.owed ? "Kept: an invoice on this job is still owed." : undefined,
        };
      });
    },
    purge: async (tx, ctx, id) => {
      const [job] = await tx.select({ number: schema.job.number }).from(schema.job).where(eq(schema.job.id, id)).limit(1);
      if (!job) throw new NotFoundError("Job");
      const visits = (await tx.select({ id: schema.visit.id }).from(schema.visit).where(eq(schema.visit.jobId, id)))
        .map((v) => v.id);
      const onJob = await releaseAttachments(tx, ctx.actor.organizationId, "job", [id], "photo");
      const onVisits = await releaseAttachments(tx, ctx.actor.organizationId, "visit", visits, "photo");
      return { jobNumber: job.number, photos: onJob + onVisits };
    },
  },
  /**
   * WHAT SOMEBODY SENT ON A LEAD FORM, kept whether or not it was any good.
   * The customer, the job and the marketing touch it led to are their own
   * records and stay. Kept while a booking draft the intake assistant made
   * from it is still waiting for the office, because that draft reads it.
   */
  form_submission: {
    label: "Lead form submissions",
    table: "form_submission",
    kindRule: "The form's own name in its embed code, such as quote.",
    candidates: async (tx, limit, zone) => {
      const rows = await tx.execute<{ id: string; created_at: Date; slug: string; waiting: boolean }>(sql`
        select s.id, s.created_at, f.slug,
          exists (
            select 1 from public.ai_agent_proposal p
            where p.organization_id = s.organization_id and p.source_kind = 'form_submission'
              and p.source_id = s.id::text and p.status = 'proposed'
          ) as waiting
        from public.form_submission s
        join public.web_form f on f.id = s.form_id
        order by s.created_at asc
        limit ${limit}`);
      return [...rows].map((row) => {
        const createdAt = new Date(row.created_at);
        return {
          id: row.id,
          label: `"${row.slug}" form sent ${day(createdAt, zone)}`,
          kind: row.slug,
          facts: { createdAt, recordDate: createdAt },
          keep: row.waiting ? "Kept: a booking draft made from it is still waiting for the office." : undefined,
        };
      });
    },
    purge: async (tx, ctx, id) => {
      const [row] = await tx.select().from(schema.formSubmission).where(eq(schema.formSubmission.id, id)).limit(1);
      if (!row) throw new NotFoundError("Form submission");
      const files = await releaseAttachments(tx, ctx.actor.organizationId, "form_submission", [id]);
      await tx.delete(schema.formSubmission).where(eq(schema.formSubmission.id, id));
      return { formId: row.formId, state: row.state, createdAt: row.createdAt, files };
    },
  },
};

/** Types other parts of the product purge themselves, and say where. */
const ELSEWHERE: Record<string, string> = {
  call_recording: "Call recordings are deleted by the recordings sweep, which honours the same holds.",
};

type Policy = typeof schema.retentionPolicy.$inferSelect;

export interface RecordDecision {
  entityType: string;
  id: string;
  label: string;
  state: "due" | "held" | "not_yet" | "no_clock" | "kept";
  why: string;
  /** The rule the decision was made under: the one that keeps it longest. */
  policyId: string;
  purgeableFrom: string | null;
}

/**
 * The decision for every record of one type, under every active rule for it.
 *
 * Shared by the preview and the purge, which must never disagree.
 */
async function decide(
  tx: Database, entityType: string, policies: Policy[], now: Date, zone: string,
): Promise<{ decisions: RecordDecision[]; matchedBy: Map<string, string[]> }> {
  const adapter = ADAPTERS[entityType]!;
  const candidates = await adapter.candidates(tx, CANDIDATE_LIMIT, zone);
  const holds = candidates.length === 0 ? [] : await tx.select({ entityId: schema.retentionHold.entityId })
    .from(schema.retentionHold)
    .where(and(
      eq(schema.retentionHold.entityType, entityType),
      isNull(schema.retentionHold.releasedAt),
      inArray(schema.retentionHold.entityId, candidates.map((c) => c.id)),
    ));
  const held = new Set(holds.map((h) => h.entityId));
  const matchedBy = new Map<string, string[]>();
  const decisions: RecordDecision[] = [];

  for (const candidate of candidates) {
    const matching = policies.filter((p) => p.entityKind === null || p.entityKind === candidate.kind);
    if (matching.length === 0) continue;
    for (const policy of matching) {
      const list = matchedBy.get(policy.id) ?? [];
      list.push(candidate.id);
      matchedBy.set(policy.id, list);
    }
    const base = { entityType, id: candidate.id, label: candidate.label };

    if (candidate.keep) {
      decisions.push({ ...base, state: "kept", why: candidate.keep, policyId: matching[0]!.id, purgeableFrom: null });
      continue;
    }
    const neverPurge = matching.find((p) => !p.purgeAllowed);
    const verdicts = matching.map((policy) => ({
      policy,
      verdict: rules.judge(
        { clockStart: policy.clockStart as rules.ClockStart, retainMonths: policy.retainMonths },
        candidate.facts, now, held.has(candidate.id), zone,
      ),
    }));
    /** The strictest verdict wins: no clock, then not yet (latest date), then held, then due. */
    const noClock = verdicts.find((v) => v.verdict.state === "no_clock");
    const notYet = verdicts
      .filter((v) => v.verdict.state === "not_yet")
      .sort((a, b) => purgeTime(b.verdict) - purgeTime(a.verdict))[0];
    const latest = [...verdicts].sort((a, b) => purgeTime(b.verdict) - purgeTime(a.verdict))[0]!;
    const chosen = noClock ?? notYet ?? latest;
    const from = "purgeableFrom" in chosen.verdict ? chosen.verdict.purgeableFrom.toISOString() : null;

    if (neverPurge && (chosen.verdict.state === "due" || chosen.verdict.state === "held")) {
      decisions.push({
        ...base, state: "kept", policyId: neverPurge.id, purgeableFrom: from,
        why: `Past its time, and kept because purging is off for "${neverPurge.name}".`,
      });
      continue;
    }
    decisions.push({
      ...base, state: chosen.verdict.state, why: chosen.verdict.why, policyId: chosen.policy.id, purgeableFrom: from,
    });
  }
  return { decisions, matchedBy };
}

const purgeTime = (verdict: rules.Verdict) => ("purgeableFrom" in verdict ? verdict.purgeableFrom.getTime() : Infinity);

/* --------------------------------------------------------------- reading */

export interface PolicyView {
  id: string;
  name: string;
  entityType: string;
  entityKind: string | null;
  clockStart: string;
  retainMonths: number;
  /** The rule read back as a sentence. */
  sentence: string;
  basis: string | null;
  tradePackId: string | null;
  purgeAllowed: boolean;
  active: boolean;
  /** Whether this product can act on the records the rule is about, and if not, why. */
  actsOn: boolean;
  actsOnWhy: string | null;
  kindRule: string | null;
}

function policyView(policy: Policy): PolicyView {
  const adapter = ADAPTERS[policy.entityType];
  return {
    id: policy.id,
    name: policy.name,
    entityType: policy.entityType,
    entityKind: policy.entityKind,
    clockStart: policy.clockStart,
    retainMonths: policy.retainMonths,
    sentence: rules.describePolicy({ clockStart: policy.clockStart as rules.ClockStart, retainMonths: policy.retainMonths }),
    basis: policy.basis,
    tradePackId: policy.tradePackId,
    purgeAllowed: policy.purgeAllowed,
    active: policy.active,
    actsOn: Boolean(adapter),
    actsOnWhy: adapter ? null : (ELSEWHERE[policy.entityType]
      ?? `Nothing in this product holds "${policy.entityType}" records yet, so this rule is kept on file and acts on nothing.`),
    kindRule: adapter?.kindRule ?? null,
  };
}

export async function listPolicies(ctx: ServiceContext): Promise<PolicyView[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.retentionPolicy)
      .orderBy(asc(schema.retentionPolicy.entityType), asc(schema.retentionPolicy.name));
    return rows.map(policyView);
  });
}

/**
 * Change a rule: the period, whether it is in force, and whether it may purge.
 *
 * The clock start is not changeable here, deliberately. It is the part of a
 * rule that comes from the regulation it cites, and getting it wrong is the
 * failure the whole enum exists to prevent; a company that needs a different
 * one is describing a different rule.
 */
export async function updatePolicy(
  ctx: ServiceContext,
  input: { id: string; retainMonths?: number | undefined; purgeAllowed?: boolean | undefined; active?: boolean | undefined },
) {
  if (input.retainMonths !== undefined && (!Number.isInteger(input.retainMonths) || input.retainMonths < 1 || input.retainMonths > 1200)) {
    throw new UnprocessableError("A period is a whole number of months from 1 to 1200.", [
      { path: "retainMonths", message: "1 to 1200 months." },
    ]);
  }
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const [before] = await tx.select().from(schema.retentionPolicy).where(eq(schema.retentionPolicy.id, input.id)).limit(1);
    if (!before) throw new NotFoundError("Retention rule");
    const [after] = await tx.update(schema.retentionPolicy).set({
      ...(input.retainMonths !== undefined ? { retainMonths: input.retainMonths } : {}),
      ...(input.purgeAllowed !== undefined ? { purgeAllowed: input.purgeAllowed } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.retentionPolicy.id, input.id)).returning();
    await audit(tx, ctx, "retention.policy_updated", "retention_policy", input.id, before, after);
    return policyView(after!);
  });
}

/** The kinds a company may write a rule about: the ones something here acts on. */
export const WRITABLE_TYPES = [...Object.keys(ADAPTERS), ...Object.keys(ELSEWHERE)];

export interface PolicyInput {
  name: string;
  entityType: string;
  entityKind?: string | null | undefined;
  clockStart: string;
  retainMonths: number;
  basis?: string | null | undefined;
}

/**
 * A rule the company writes itself.
 *
 * Purging is OFF, always, whatever is asked: the same footing a rule a trade
 * pack seeds starts on, so the first thing anybody sees of a new rule is its
 * preview, and removing anything is a second decision taken with that list
 * in front of them. Only about kinds of record something here acts on; a rule
 * about a kind nothing purges would sit on the screen looking like it did.
 */
export async function createPolicy(ctx: ServiceContext, input: PolicyInput): Promise<PolicyView> {
  assertCan(ctx.actor, "compliance:write");
  const name = input.name.trim();
  if (name === "") throw new ConflictError("Give the rule a name.");
  if (!WRITABLE_TYPES.includes(input.entityType)) {
    throw new ConflictError(`Nothing in this product removes "${input.entityType}" records, so a rule about them would do nothing.`);
  }
  if (!(rules.CLOCK_STARTS as readonly string[]).includes(input.clockStart)) {
    throw new ConflictError(`"${input.clockStart}" is not a clock this product knows. Choose when the time starts from the list.`);
  }
  if (!Number.isInteger(input.retainMonths) || input.retainMonths < 1 || input.retainMonths > 1200) {
    throw new UnprocessableError("A period is a whole number of months from 1 to 1200.", [
      { path: "retainMonths", message: "1 to 1200 months." },
    ]);
  }
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const seen = await replayed<PolicyView>(tx, ctx, "retention_policy");
    if (seen) return seen;
    const [row] = await tx.insert(schema.retentionPolicy).values({
      organizationId: ctx.actor.organizationId,
      name,
      entityType: input.entityType,
      entityKind: input.entityKind?.trim() || null,
      clockStart: input.clockStart as Policy["clockStart"],
      retainMonths: input.retainMonths,
      basis: input.basis?.trim() || null,
      purgeAllowed: false,
    }).returning();
    await audit(tx, ctx, "retention.policy_created", "retention_policy", row!.id, null, row);
    const view = policyView(row!);
    await remember(tx, ctx, "retention_policy", row!.id, view);
    return view;
  });
}

export interface PreviewRow {
  policy: PolicyView;
  counts: { due: number; held: number; notYet: number; kept: number };
  /** The records that would go, and the held ones, up to the sample size. */
  records: RecordDecision[];
  /** What a purge would do with this rule today, in a sentence. */
  summary: string;
}

/**
 * What a purge would do, rule by rule, without doing it.
 *
 * The same decisions the purge makes, from the same function, at the same
 * moment. `due` counts records a purge would remove now only if the rule's
 * purging is on; with it off, they are counted as kept and the summary says
 * that turning it on is what would remove them.
 */
export async function preview(
  ctx: ServiceContext, input: { policyId?: string | undefined; sample?: number | undefined } = {},
): Promise<PreviewRow[]> {
  const sample = Math.min(input.sample ?? 25, 200);
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const all = await tx.select().from(schema.retentionPolicy).where(eq(schema.retentionPolicy.active, true))
      .orderBy(asc(schema.retentionPolicy.entityType), asc(schema.retentionPolicy.name));
    const shown = input.policyId ? all.filter((p) => p.id === input.policyId) : all;
    if (input.policyId && shown.length === 0) throw new NotFoundError("Active retention rule");

    const now = new Date();
    const byType = new Map<string, Awaited<ReturnType<typeof decide>>>();
    for (const type of new Set(shown.map((p) => p.entityType))) {
      if (!ADAPTERS[type]) continue;
      byType.set(type, await decide(tx, type, all.filter((p) => p.entityType === type), now,
        await timezoneOf(tx, ctx.actor.organizationId)));
    }

    return shown.map((policy) => {
      const view = policyView(policy);
      const found = byType.get(policy.entityType);
      if (!found) {
        return { policy: view, counts: { due: 0, held: 0, notYet: 0, kept: 0 }, records: [], summary: view.actsOnWhy! };
      }
      const mine = new Set(found.matchedBy.get(policy.id) ?? []);
      const decisions = found.decisions.filter((d) => mine.has(d.id));
      const counts = {
        due: decisions.filter((d) => d.state === "due").length,
        held: decisions.filter((d) => d.state === "held").length,
        notYet: decisions.filter((d) => d.state === "not_yet").length,
        kept: decisions.filter((d) => d.state === "kept" || d.state === "no_clock").length,
      };
      const summary = decisions.length === 0
        ? (view.entityKind && view.kindRule
          ? `No record here is of kind "${view.entityKind}". ${view.kindRule}`
          : "No records of this kind yet.")
        : counts.due > 0
          ? `${counts.due} would be removed on the next purge.`
          : !policy.purgeAllowed
            ? "Purging is off for this rule, so nothing it covers is removed. Turn it on to let the purge act."
            : counts.held > 0
              ? `Nothing would be removed: ${counts.held} past their time are on hold.`
              : "Nothing is due yet.";
      return {
        policy: view,
        counts,
        records: decisions.filter((d) => d.state === "due" || d.state === "held" || d.state === "kept").slice(0, sample),
        summary,
      };
    });
  });
}

/* ----------------------------------------------------------------- holds */


export interface HoldView {
  id: string;
  entityType: string;
  entityId: string;
  reason: string;
  placedAt: string;
  releasedAt: string | null;
  releaseNote: string | null;
}

export async function listHolds(
  ctx: ServiceContext,
  input: { includeReleased?: boolean | undefined; entityType?: string | undefined; entityId?: string | undefined } = {},
): Promise<HoldView[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.retentionHold)
      .where(and(
        input.includeReleased ? undefined : isNull(schema.retentionHold.releasedAt),
        input.entityType ? eq(schema.retentionHold.entityType, input.entityType) : undefined,
        input.entityId ? eq(schema.retentionHold.entityId, input.entityId) : undefined,
      ))
      .orderBy(desc(schema.retentionHold.placedAt)).limit(500);
    return rows.map((row) => ({
      id: row.id, entityType: row.entityType, entityId: row.entityId, reason: row.reason,
      placedAt: row.placedAt.toISOString(), releasedAt: row.releasedAt?.toISOString() ?? null,
      releaseNote: row.releaseNote,
    }));
  });
}

/** The hold on one record, for that record's own page, or null when it is not held. */
export async function holdOn(ctx: ServiceContext, input: { entityType: string; entityId: string }): Promise<HoldView | null> {
  return (await listHolds(ctx, input))[0] ?? null;
}

/** The kinds that can be held, and the table each one's id is looked for in. */
export const HOLDABLE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ADAPTERS).map(([type, adapter]) => [type, adapter.table])),
  call_recording: "call",
};

/**
 * Keep this record whatever its age. Placing a hold on a record that already
 * has one changes nothing and succeeds: two holds on one record would need
 * two releases, and the second is the one somebody forgets.
 */
export async function placeHold(ctx: ServiceContext, input: { entityType: string; entityId: string; reason: string }) {
  const reason = input.reason.trim();
  if (reason === "") throw new UnprocessableError("Say why it is being kept.", [{ path: "reason", message: "Required." }]);
  const table = HOLDABLE[input.entityType];
  if (!table) {
    throw new UnprocessableError(`Nothing purges "${input.entityType}" records, so there is nothing to hold them against.`, [
      { path: "entityType", message: `One of ${Object.keys(HOLDABLE).join(", ")}.` },
    ]);
  }
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const [existing] = await tx.select().from(schema.retentionHold)
      .where(and(
        eq(schema.retentionHold.entityType, input.entityType),
        eq(schema.retentionHold.entityId, input.entityId),
        isNull(schema.retentionHold.releasedAt),
      )).limit(1);
    if (existing) return { id: existing.id, placedAt: existing.placedAt.toISOString() };
    const exists = await tx.execute(sql`
      select 1 from ${sql.raw(`public.${table}`)} where id = ${input.entityId} limit 1`);
    if (exists.length === 0) throw new NotFoundError("Record");
    const [row] = await tx.insert(schema.retentionHold).values({
      organizationId: ctx.actor.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      reason,
      placedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
    }).returning();
    await audit(tx, ctx, "retention.hold_placed", input.entityType, input.entityId, null, { holdId: row!.id, reason });
    return { id: row!.id, placedAt: row!.placedAt.toISOString() };
  });
}

export async function releaseHold(ctx: ServiceContext, input: { id: string; note?: string | undefined }) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const [row] = await tx.select().from(schema.retentionHold).where(eq(schema.retentionHold.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Hold");
    if (row.releasedAt) return { releasedAt: row.releasedAt.toISOString() };
    const now = new Date();
    await tx.update(schema.retentionHold).set({
      releasedAt: now, releasedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
      releaseNote: input.note?.trim() || null,
    }).where(eq(schema.retentionHold.id, input.id));
    await audit(tx, ctx, "retention.hold_released", row.entityType, row.entityId, { holdId: row.id }, { note: input.note ?? null });
    return { releasedAt: now.toISOString() };
  });
}

/** Whether a record is held. The recordings sweep asks this. */
export async function isHeld(tx: Database, entityType: string, entityId: string): Promise<boolean> {
  const [row] = await tx.select({ id: schema.retentionHold.id }).from(schema.retentionHold)
    .where(and(
      eq(schema.retentionHold.entityType, entityType),
      eq(schema.retentionHold.entityId, entityId),
      isNull(schema.retentionHold.releasedAt),
    )).limit(1);
  return Boolean(row);
}

/* ----------------------------------------------------------------- purge */

export interface RunView {
  id: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  purged: number;
  held: number;
  failed: number;
  failures: Array<{ entityType: string; entityId: string; reason: string }>;
}

const runView = (row: typeof schema.retentionPurgeRun.$inferSelect): RunView => ({
  id: row.id, trigger: row.trigger, startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  purged: row.purged, held: row.held, failed: row.failed, failures: row.failures,
});

/**
 * One pass, inside the tenant. Each record is removed in a savepoint of its
 * own, so one that cannot be removed (something unexpected still points at
 * it) is written down as a failure and the pass carries on, rather than the
 * whole pass rolling back and the same record stopping every pass after it.
 */
async function runIn(
  tx: Database, ctx: ServiceContext, trigger: "worker" | "person", now: Date,
): Promise<RunView> {
  const [run] = await tx.insert(schema.retentionPurgeRun).values({
    organizationId: ctx.actor.organizationId,
    trigger,
    requestedByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
    startedAt: now,
  }).returning();

  const policies = await tx.select().from(schema.retentionPolicy).where(eq(schema.retentionPolicy.active, true));
  let purged = 0;
  let held = 0;
  const failures: RunView["failures"] = [];

  for (const type of new Set(policies.filter((p) => p.purgeAllowed).map((p) => p.entityType))) {
    const adapter = ADAPTERS[type];
    if (!adapter) continue;
    const { decisions } = await decide(tx, type, policies.filter((p) => p.entityType === type), now,
      await timezoneOf(tx, ctx.actor.organizationId));
    held += decisions.filter((d) => d.state === "held").length;
    for (const decision of decisions.filter((d) => d.state === "due")) {
      if (purged >= PURGE_LIMIT) break;
      const policy = policies.find((p) => p.id === decision.policyId)!;
      try {
        await tx.transaction(async (inner) => {
          const db = inner as unknown as Database;
          const before = await adapter.purge(db, ctx, decision.id);
          await audit(db, ctx, "retention.purged", type, decision.id, before, {
            runId: run!.id,
            policyId: policy.id,
            policy: policy.name,
            clockStart: policy.clockStart,
            retainMonths: policy.retainMonths,
            purgeableFrom: decision.purgeableFrom,
          });
        });
        purged += 1;
      } catch (error) {
        failures.push({ entityType: type, entityId: decision.id, reason: (error as Error).message.slice(0, 300) });
      }
    }
  }

  const [finished] = await tx.update(schema.retentionPurgeRun).set({
    finishedAt: new Date(), purged, held, failed: failures.length, failures,
  }).where(eq(schema.retentionPurgeRun.id, run!.id)).returning();
  return runView(finished!);
}

/**
 * Purge now, because somebody pressed the button. Idempotent: a retry with
 * the same key returns the pass the first press made rather than running a
 * second one.
 */
export async function runNow(ctx: ServiceContext): Promise<RunView> {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId }).from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.eventType, "retention.purge_run"),
        )).limit(1);
      if (seen?.entityId) {
        const [run] = await tx.select().from(schema.retentionPurgeRun)
          .where(eq(schema.retentionPurgeRun.id, seen.entityId)).limit(1);
        if (run) return runView(run);
      }
    }
    const run = await runIn(tx, ctx, "person", new Date());
    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId, direction: "inbound", provider: "api",
        eventType: "retention.purge_run", idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "retention_purge_run", entityId: run.id,
      });
    }
    return run;
  });
}

export async function listRuns(ctx: ServiceContext, input: { limit?: number | undefined } = {}) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.retentionPurgeRun)
      .orderBy(desc(schema.retentionPurgeRun.startedAt)).limit(input.limit ?? 30);
    return rows.map(runView);
  });
}

/**
 * The worker's daily pass: every company with a rule it switched purging on
 * for and no pass in the last twenty hours. One company's failure is that
 * company's, and the pass goes on.
 */
export async function purgePass(
  db: Database, options: { now?: Date; limit?: number; shouldStop?: () => boolean } = {},
): Promise<Array<{ organizationId: string; run?: RunView; error?: string }>> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.retention_purge_organizations(${options.limit ?? 50})`,
  );
  const results: Array<{ organizationId: string; run?: RunView; error?: string }> = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const ctx: ServiceContext = { actor: { userId: SYSTEM_USER_ID, organizationId: row.organization_id, roles: [] }, db };
    try {
      const run = await inTenant(ctx, (tx) => runIn(tx, ctx, "worker", options.now ?? new Date()));
      results.push({ organizationId: row.organization_id, run });
    } catch (error) {
      results.push({ organizationId: row.organization_id, error: (error as Error).message });
    }
  }
  return results;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listRetentionPolicies: async (ctx: ServiceContext) => ({ policies: await listPolicies(ctx) }),
  updateRetentionPolicy: (
    ctx: ServiceContext,
    input: { id: string; retainMonths?: number | undefined; purgeAllowed?: boolean | undefined; active?: boolean | undefined },
  ) => updatePolicy(ctx, input),
  previewRetentionPurge: async (
    ctx: ServiceContext, input: { policyId?: string | undefined; sample?: number | undefined },
  ) => ({ rules: await preview(ctx, input) }),
  createRetentionPolicy: (ctx: ServiceContext, input: PolicyInput) => createPolicy(ctx, input),
  listRetentionHolds: async (
    ctx: ServiceContext,
    input: { includeReleased?: boolean | undefined; entityType?: string | undefined; entityId?: string | undefined },
  ) => ({ holds: await listHolds(ctx, input) }),
  placeRetentionHold: (ctx: ServiceContext, input: { entityType: string; entityId: string; reason: string }) =>
    placeHold(ctx, input),
  releaseRetentionHold: (ctx: ServiceContext, input: { id: string; note?: string | undefined }) => releaseHold(ctx, input),
  runRetentionPurge: (ctx: ServiceContext) => runNow(ctx),
  listRetentionPurgeRuns: async (ctx: ServiceContext, input: { limit?: number | undefined }) =>
    ({ runs: await listRuns(ctx, input) }),
} as const;
