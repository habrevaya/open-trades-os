import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, time, work } from "@opentradesos/core";
import { audit, guardedRead, timezoneOf, type ServiceContext } from "./context";
import { raiseWithin } from "./staff-notices";
import { sideOf } from "./visit-notices";

/**
 * A CUSTOMER'S UPLOAD FROM THE PORTAL, NOTICED
 *
 * A customer sending photos or a PDF to a job from their account used to raise
 * nothing: the office saw it when it next opened the job, and the technician
 * when they opened the visit. Now, in the transaction that keeps the file:
 *
 *   ONE OFFICE TASK A DAY FOR EACH JOB. The first file of the company's day
 *   claims the job's day (`customer_upload_day`, unique) and raises a task in
 *   the office queue about the job, in nobody's name; each file after it that
 *   day adds to its count ("Rosa Reyes sent 3 files to job 1042"). A task
 *   already finished that day (everything sent was opened) is not reopened: the
 *   next file raises a new one, which the day then names.
 *
 *   A NOTICE TO THE JOB'S TECHNICIANS through the staff notice path (bell,
 *   phone, text as each person chose), once a day per job per person: the
 *   people on the visit the file was sent to, or for a file sent to the job,
 *   the people on its visits still to come, each about their own soonest one.
 *   A notice is never raised about a visit the person cannot open
 *   (`raiseWithin` asks), and nobody is told about a file on a visit that is
 *   over.
 *
 *   NEW UNTIL SOMEBODY OPENS IT. The job's page shows each unopened file as
 *   new, and the count at the top; opening one from the job's page or through
 *   the API (`files.markSeen`) marks it. When nothing the customer sent to the
 *   job is left unopened, the day's tasks still open are finished, saying so.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Visits a file can still matter to: not done, not called off. */
const STILL_TO_DO = ["unassigned", "scheduled", "dispatched", "en_route", "working"] as const;

export interface UploadNoticed { taskId: string; files: number; told: number }

export async function noticeUpload(
  tx: Database, ctx: ServiceContext,
  input: {
    job: { id: string; number: number; numberPrefix: string | null; summary: string; customerId: string };
    entity: { type: "job" | "visit"; id: string };
    attachmentId: string;
    now?: Date | undefined;
  },
): Promise<UploadNoticed> {
  const organizationId = ctx.actor.organizationId;
  const now = input.now ?? new Date();
  const zone = await timezoneOf(tx, organizationId);
  const onDay = time.dateIn(now, zone);

  /** The claim: one row per job per company day, and the count on it. */
  await tx.insert(schema.customerUploadDay).values({ organizationId, jobId: input.job.id, onDay, files: 0 })
    .onConflictDoNothing();
  const [day] = await tx.update(schema.customerUploadDay)
    .set({ files: sql`${schema.customerUploadDay.files} + 1`, updatedAt: now })
    .where(and(
      eq(schema.customerUploadDay.organizationId, organizationId),
      eq(schema.customerUploadDay.jobId, input.job.id),
      eq(schema.customerUploadDay.onDay, onDay),
    )).returning();

  const [customer] = await tx.select({ name: schema.customer.name }).from(schema.customer)
    .where(eq(schema.customer.id, input.job.customerId)).limit(1);
  const customerName = customer?.name ?? "A customer";
  const jobLabel = work.documentNumber(input.job.numberPrefix, input.job.number);

  /** What the file was sent to, in words: "the visit on Thu, Oct 22", or the job. */
  let forVisit: string | null = null;
  if (input.entity.type === "visit") {
    const [visit] = await tx.select({ windowStart: schema.visit.windowStart }).from(schema.visit)
      .where(eq(schema.visit.id, input.entity.id)).limit(1);
    forVisit = visit?.windowStart
      ? `the visit on ${new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(visit.windowStart)}`
      : "a visit";
  }

  const title = work.customerFilesTitle({ customerName, jobLabel, files: day!.files });
  const body = work.customerFilesBody({ summary: input.job.summary, files: day!.files, forVisit });
  const [current] = day!.taskId
    ? await tx.select({ id: schema.task.id, status: schema.task.status }).from(schema.task)
      .where(eq(schema.task.id, day!.taskId)).limit(1)
    : [];
  let taskId: string;
  if (current && (current.status === "open" || current.status === "in_progress")) {
    await tx.update(schema.task).set({ title, body, updatedAt: now }).where(eq(schema.task.id, current.id));
    taskId = current.id;
  } else {
    const [task] = await tx.insert(schema.task).values({
      organizationId,
      title,
      body,
      priority: "normal",
      entityType: "job",
      entityId: input.job.id,
      queue: "office",
    }).returning({ id: schema.task.id });
    taskId = task!.id;
    await tx.update(schema.customerUploadDay).set({ taskId, updatedAt: now }).where(eq(schema.customerUploadDay.id, day!.id));
    await audit(tx, ctx, "task.raised_for_customer_files", "task", taskId, null, {
      jobId: input.job.id, onDay, attachmentId: input.attachmentId,
    });
  }

  /** Who is told, each about their own visit: the file's visit, or each person's soonest still to come on the job. */
  const visits = input.entity.type === "visit"
    ? await tx.select({ id: schema.visit.id, status: schema.visit.status }).from(schema.visit)
      .where(eq(schema.visit.id, input.entity.id))
    : await tx.select({ id: schema.visit.id, status: schema.visit.status }).from(schema.visit)
      .where(and(eq(schema.visit.jobId, input.job.id), inArray(schema.visit.status, [...STILL_TO_DO])))
      .orderBy(asc(schema.visit.windowStart));
  const aboutFor = new Map<string, string>();
  for (const visit of visits) {
    if (!(STILL_TO_DO as readonly string[]).includes(visit.status)) continue;
    for (const technicianId of (await sideOf(tx, visit.id))?.technicianIds ?? []) {
      if (!aboutFor.has(technicianId)) aboutFor.set(technicianId, visit.id);
    }
  }
  let told = 0;
  if (aboutFor.size > 0) {
    const people = await tx.select({ technicianId: schema.technician.id, userId: schema.membership.userId })
      .from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(inArray(schema.technician.id, [...aboutFor.keys()]));
    const [file] = await tx.select({ contentType: schema.attachment.contentType }).from(schema.attachment)
      .where(eq(schema.attachment.id, input.attachmentId)).limit(1);
    const what = file?.contentType?.startsWith("image/") ? "a photo" : "a file";
    for (const person of people) {
      if (!person.userId || person.userId === SYSTEM_USER_ID) continue;
      const outcome = await raiseWithin(tx, {
        organizationId,
        userId: person.userId,
        kind: "customer_file",
        key: `customer_file:${input.job.id}:${onDay}`,
        title: `${customerName} sent ${what} for job ${jobLabel}`,
        body: `${input.job.summary}. Open the visit to see it.`,
        about: { type: "visit", id: aboutFor.get(person.technicianId)! },
      });
      if (outcome.told) told += 1;
    }
  }
  return { taskId, files: day!.files, told };
}

/**
 * Somebody opened a file the customer sent, or the customer took one back. When nothing the customer sent to
 * that job (on the job or on any of its visits) is left unopened, the day's
 * tasks for it still open are finished: the files have been looked at, which
 * is all the task asked.
 */
export async function afterOpened(
  tx: Database, ctx: ServiceContext, attachment: { entityType: string; entityId: string },
  outcome = "Everything the customer sent has been opened.",
): Promise<void> {
  const jobId = attachment.entityType === "job"
    ? attachment.entityId
    : attachment.entityType === "visit"
      ? (await tx.select({ jobId: schema.visit.jobId }).from(schema.visit).where(eq(schema.visit.id, attachment.entityId)).limit(1))[0]?.jobId
      : undefined;
  if (!jobId) return;
  const [left] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from public.attachment a
    where a.kind = 'customer_file' and a.deleted_at is null and a.seen_at is null
      and (a.entity_id = ${jobId}::uuid or a.entity_id in (select v.id from public.visit v where v.job_id = ${jobId}::uuid))`);
  if (Number(left?.n ?? 0) > 0) return;
  const days = await tx.select({ taskId: schema.customerUploadDay.taskId }).from(schema.customerUploadDay)
    .where(eq(schema.customerUploadDay.jobId, jobId));
  const ids = days.map((d) => d.taskId).filter((id): id is string => id !== null);
  if (ids.length === 0) return;
  const now = new Date();
  const closed = await tx.update(schema.task).set({
    status: "done",
    outcome,
    completedAt: now,
    /** A person in the company who opened it; nobody, when it was the customer taking one back from their sign in. */
    completedByUserId: ctx.actor.userId === SYSTEM_USER_ID || !UUID.test(ctx.actor.userId) ? null : ctx.actor.userId,
    updatedAt: now,
  }).where(and(inArray(schema.task.id, ids), inArray(schema.task.status, ["open", "in_progress"])))
    .returning({ id: schema.task.id });
  for (const task of closed) {
    await audit(tx, ctx, "task.finished_files_opened", "task", task.id, { status: "open" }, { status: "done" });
  }
}

/** How many files the customer sent to a job (on it or its visits) nobody here has opened yet. */
export function unopenedOnJob(ctx: ServiceContext, input: { jobId: string }): Promise<number> {
  return guardedRead(ctx, "document:read", async (tx) => {
    const visitIds = (await tx.select({ id: schema.visit.id }).from(schema.visit).where(eq(schema.visit.jobId, input.jobId)))
      .map((v) => v.id);
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.attachment)
      .where(and(
        eq(schema.attachment.organizationId, ctx.actor.organizationId),
        eq(schema.attachment.kind, "customer_file"),
        isNull(schema.attachment.deletedAt),
        isNull(schema.attachment.seenAt),
        inArray(schema.attachment.entityId, [input.jobId, ...visitIds]),
      ));
    return Number(row?.n ?? 0);
  });
}
