import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { automation, reviews as rv } from "@opentradesos/core";
import { loadHolidays } from "./holidays";
import { askStyleFor } from "./review-asks";
import {
  audit, guardedRead, guardedWrite, NotFoundError, ConflictError, type ServiceContext,
} from "./context";

/**
 * REVIEWS AND REPUTATION
 *
 * For a local trades company the listing is worth more than the website: a
 * homeowner searching "AC repair near me" sees a rating and the reply under
 * the worst review before they see anything the company wrote about itself.
 *
 * `packages/core/src/reviews` is twelve hundred lines that knew when to ask,
 * who to ring instead, what a rating actually is, and which reply is owed by
 * when. It had no tables and no callers.
 *
 * THE ONE THING THIS FILE MUST NEVER LEARN HOW TO DO
 *
 * Ask only the customers who will say something nice. That is review gating,
 * every major platform prohibits it, and it is what gets a listing's reviews
 * wiped. It is also trivially easy to build by accident: one predicted
 * rating and a `where predicted >= 4` and the product is doing it.
 *
 * Core defends against that with `REQUEST_INPUTS`, a declared list of every
 * fact the ask decision may read, enforced by a test that proxies the input
 * and fails if anything outside the list is touched. This file defends
 * against it by having nowhere to put such a number: there is no column, and
 * `factsFor` below builds the input from exactly those fields.
 *
 * WHAT IS BUILT AND WHAT IS NOT
 *
 * No review platform connector exists. The catalogue says so. Reviews are
 * entered by hand today, and that is not a placeholder: a company with forty
 * reviews and a work list telling them which three are owed a reply is
 * better off than one waiting for an API.
 */

/* --------------------------------------------------------------- policy */

/**
 * The company's own service standard, in the shape core takes.
 *
 * REFUSED rather than defaulted when no policy is set, like the overtime
 * policy. Every number here is a decision about how a company talks to its
 * customers: how soon after a visit, how often at most, how late in the
 * evening. A guessed default produces messages going out at nine at night
 * to somebody who had four jobs that week, and nothing on any screen would
 * say the product chose that.
 */
export async function policyFor(tx: Database, organizationId: string) {
  const [row] = await tx.select().from(schema.reviewPolicy)
    .where(and(
      eq(schema.reviewPolicy.organizationId, organizationId),
      eq(schema.reviewPolicy.active, true),
      isNull(schema.reviewPolicy.deletedAt),
    )).limit(1);

  if (!row) {
    throw new ConflictError(
      "No review policy is set for this company. Set one before asking anybody for a review: "
      + "every number in it is a decision about how you talk to your customers, and a guessed default "
      + "sends messages at nine at night to somebody who had four jobs that week.",
    );
  }
  return row;
}

const requestPolicy = (row: typeof schema.reviewPolicy.$inferSelect): rv.RequestPolicy => ({
  timeZone: row.timeZone,
  delayMinutes: row.delayMinutes,
  customerCooldownDays: row.customerCooldownDays,
  requirePaid: row.requirePaid,
  maxJobAgeDays: row.maxJobAgeDays,
  earliestHour: row.earliestHour,
  latestHour: row.latestHour,
});

const responsePolicy = (row: typeof schema.reviewPolicy.$inferSelect): rv.ResponsePolicy => ({
  timeZone: row.timeZone,
  businessDays: row.businessDays,
  openHour: row.openHour,
  closeHour: row.closeHour,
  /**
   * The company's bands, falling back to core's starting point when nobody
   * has edited them. Worth contrasting with the platform policies below,
   * which ship no defaults at all: the difference is whose rule it is.
   * Being wrong about your own service standard costs a reply sent a day
   * late. Being wrong about somebody else's rule costs the listing.
   */
  bands: row.bands.length > 0 ? row.bands : rv.DEFAULT_RESPONSE_BANDS,
});

export interface PolicyInput {
  timeZone: string;
  delayMinutes?: number | undefined;
  customerCooldownDays?: number | undefined;
  requirePaid?: boolean | undefined;
  maxJobAgeDays?: number | undefined;
  earliestHour?: number | undefined;
  latestHour?: number | undefined;
  recoverAtOrBelow?: number | undefined;
  sameDayAtOrBelow?: number | undefined;
  businessDays?: number[] | undefined;
  openHour?: number | undefined;
  closeHour?: number | undefined;
  bands?: rv.ResponseBand[] | undefined;
  halfLifeDays?: number | undefined;
  /**
   * Days to wait before the one reminder; null turns it off. Left out, the policy keeps
   * what it had, so saving the service standard does not quietly switch reminders off.
   */
  reminderAfterDays?: number | null | undefined;
}

/**
 * What `setPolicy` stores for a field left out. Named once, so the policy
 * screen shows the same numbers it would save, and a test can say so.
 * Not a default the product uses without a policy: with none, nothing is
 * asked at all (`policyFor`).
 */
export const POLICY_STARTING_POINT = Object.freeze({
  delayMinutes: 120,
  customerCooldownDays: 90,
  requirePaid: true,
  maxJobAgeDays: 14,
  earliestHour: 9,
  latestHour: 19,
  recoverAtOrBelow: 3,
  sameDayAtOrBelow: 2,
  businessDays: Object.freeze([1, 2, 3, 4, 5]) as readonly number[],
  openHour: 8,
  closeHour: 17,
  halfLifeDays: 365,
});

/**
 * The policy as it stands, or null when none is set. For the screen that
 * sets it, so `settings:read`, the permission of the settings around it.
 */
export async function currentPolicy(ctx: ServiceContext) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const [row] = await tx.select().from(schema.reviewPolicy)
      .where(and(
        eq(schema.reviewPolicy.organizationId, ctx.actor.organizationId),
        eq(schema.reviewPolicy.active, true),
        isNull(schema.reviewPolicy.deletedAt),
      )).limit(1);
    return row ?? null;
  });
}

export async function setPolicy(ctx: ServiceContext, input: PolicyInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const bands: rv.ResponseBand[] = input.bands ?? rv.DEFAULT_RESPONSE_BANDS.map((b) => ({ ...b }));
    const proposed: rv.ResponsePolicy = {
      timeZone: input.timeZone,
      businessDays: input.businessDays ?? [...POLICY_STARTING_POINT.businessDays],
      openHour: input.openHour ?? POLICY_STARTING_POINT.openHour,
      closeHour: input.closeHour ?? POLICY_STARTING_POINT.closeHour,
      bands,
    };

    /**
     * Checked by core before it is stored. `checkResponsePolicy` catches
     * the things that make a work list wrong rather than merely odd: bands
     * that do not cover every rating, a band that closes before it opens,
     * business hours that describe no hours at all.
     */
    const verdict = rv.checkResponsePolicy(proposed);
    if (!verdict.ok) throw new ConflictError(verdict.reason);
    /**
     * A zone the runtime does not know would throw on the first deadline
     * worked out from it, on the reply queue, long after it was saved.
     */
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone });
    } catch {
      throw new ConflictError(`"${input.timeZone}" is not a time zone. Write it like America/Chicago.`);
    }

    const values = {
      organizationId: ctx.actor.organizationId,
      timeZone: input.timeZone,
      delayMinutes: input.delayMinutes ?? POLICY_STARTING_POINT.delayMinutes,
      customerCooldownDays: input.customerCooldownDays ?? POLICY_STARTING_POINT.customerCooldownDays,
      requirePaid: input.requirePaid ?? POLICY_STARTING_POINT.requirePaid,
      maxJobAgeDays: input.maxJobAgeDays ?? POLICY_STARTING_POINT.maxJobAgeDays,
      earliestHour: input.earliestHour ?? POLICY_STARTING_POINT.earliestHour,
      latestHour: input.latestHour ?? POLICY_STARTING_POINT.latestHour,
      recoverAtOrBelow: input.recoverAtOrBelow ?? POLICY_STARTING_POINT.recoverAtOrBelow,
      sameDayAtOrBelow: input.sameDayAtOrBelow ?? POLICY_STARTING_POINT.sameDayAtOrBelow,
      businessDays: proposed.businessDays as number[],
      openHour: proposed.openHour,
      closeHour: proposed.closeHour,
      /**
       * Spread into a mutable array. Core's `DEFAULT_RESPONSE_BANDS` is
       * `readonly`, which drizzle's insert type will not take, and the
       * readonly is right where it lives: nothing should be able to edit
       * the shipped defaults in place.
       */
      bands: bands.map((band) => ({ ...band })),
      halfLifeDays: input.halfLifeDays ?? POLICY_STARTING_POINT.halfLifeDays,
      ...(input.reminderAfterDays !== undefined ? { reminderAfterDays: input.reminderAfterDays } : {}),
      active: true,
    };
    if (input.reminderAfterDays !== undefined) {
      const days = rv.checkReminderDays(input.reminderAfterDays);
      if (!days.ok) throw new ConflictError(days.reason);
    }

    const [row] = await tx.insert(schema.reviewPolicy).values(values)
      .onConflictDoUpdate({
        target: [schema.reviewPolicy.organizationId],
        targetWhere: sql`active and deleted_at is null`,
        set: { ...values, updatedAt: new Date() },
      }).returning();

    await audit(tx, ctx, "review_policy.set", "review_policy", row!.id, null, row!);
    return row!;
  });
}

/* ------------------------------------------------------------- reminders */

export interface RemindersView {
  /** Null is off. */
  afterDays: number | null;
  /** The words it goes in, and whether they are the company's own or the ones we ship. */
  wording: rv.ReviewWording & { custom: boolean };
  /** The latest reminders, sent or decided against, newest first. */
  recent: {
    requestId: string; jobNumber: number; customerName: string;
    askedAt: string; remindedAt: string; sent: boolean; detail: string | null;
  }[];
  /** Null is off. Days after the first reminder went. */
  secondAfterDays: number | null;
  /** Null is off. Days after a text ask before the ask goes again by email. */
  followUpAfterDays: number | null;
  /** The company asks by text and then email, the only way a follow up by email is sent. */
  followUpApplies: boolean;
  /** The latest follow ups and second reminders, sent or decided against, newest first. */
  later: {
    requestId: string; jobNumber: number; customerName: string;
    kind: "follow_up" | "second_reminder"; at: string; sent: boolean; detail: string | null;
  }[];
}

/** Whether a reminder goes, and what the last ones did. */
export async function reminders(ctx: ServiceContext): Promise<RemindersView> {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const policy = await policyFor(tx, ctx.actor.organizationId);
    const rows = await tx.select({
      id: schema.reviewRequest.id, sentAt: schema.reviewRequest.sentAt, reminderAt: schema.reviewRequest.reminderAt,
      messageId: schema.reviewRequest.reminderMessageId, detail: schema.reviewRequest.reminderDetail,
      jobNumber: schema.job.number, customerName: schema.customer.name,
    }).from(schema.reviewRequest)
      .innerJoin(schema.job, eq(schema.job.id, schema.reviewRequest.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.reviewRequest.customerId))
      .where(and(sql`${schema.reviewRequest.reminderAt} is not null`, isNull(schema.reviewRequest.deletedAt)))
      .orderBy(desc(schema.reviewRequest.reminderAt)).limit(25);
    const laterRows = await tx.select({
      id: schema.reviewRequest.id, jobNumber: schema.job.number, customerName: schema.customer.name,
      followUpAt: schema.reviewRequest.followUpAt, followUpMessageId: schema.reviewRequest.followUpMessageId,
      followUpDetail: schema.reviewRequest.followUpDetail,
      secondAt: schema.reviewRequest.secondReminderAt, secondMessageId: schema.reviewRequest.secondReminderMessageId,
      secondDetail: schema.reviewRequest.secondReminderDetail,
    }).from(schema.reviewRequest)
      .innerJoin(schema.job, eq(schema.job.id, schema.reviewRequest.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.reviewRequest.customerId))
      .where(and(
        sql`(${schema.reviewRequest.followUpAt} is not null or ${schema.reviewRequest.secondReminderAt} is not null)`,
        isNull(schema.reviewRequest.deletedAt),
      ))
      .orderBy(desc(sql`greatest(${schema.reviewRequest.followUpAt}, ${schema.reviewRequest.secondReminderAt})`)).limit(25);
    const later: RemindersView["later"] = laterRows.flatMap((r) => [
      ...(r.secondAt ? [{
        requestId: r.id, jobNumber: r.jobNumber, customerName: r.customerName, kind: "second_reminder" as const,
        at: r.secondAt.toISOString(), sent: r.secondMessageId !== null, detail: r.secondDetail,
      }] : []),
      ...(r.followUpAt ? [{
        requestId: r.id, jobNumber: r.jobNumber, customerName: r.customerName, kind: "follow_up" as const,
        at: r.followUpAt.toISOString(), sent: r.followUpMessageId !== null, detail: r.followUpDetail,
      }] : []),
    ]).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
    return {
      afterDays: policy.reminderAfterDays,
      wording: { ...reminderWording(policy), custom: policy.reminderSms !== null },
      recent: rows.map((r) => ({
        requestId: r.id, jobNumber: r.jobNumber, customerName: r.customerName,
        askedAt: (r.sentAt ?? r.reminderAt!).toISOString(), remindedAt: r.reminderAt!.toISOString(),
        sent: r.messageId !== null, detail: r.detail,
      })),
      secondAfterDays: policy.secondReminderAfterDays,
      followUpAfterDays: policy.followUpAfterDays,
      followUpApplies: (await askStyleFor(tx)).channel === "sms_then_email",
      later,
    };
  });
}

/**
 * The words the reminder goes in: the company's own when it changed them,
 * else the ones we ship. The worker and the screen both read it here.
 */
export function reminderWording(policy: Pick<typeof schema.reviewPolicy.$inferSelect,
  "reminderSms" | "reminderEmailSubject" | "reminderEmailBody"> & {
    secondReminderAfterDays?: number | null | undefined;
  }): rv.ReviewWording {
  /**
   * With a second reminder on, the words we ship drop "This is the only
   * reminder we will send", which would then be untrue. A company's own words
   * are its own.
   */
  const shipped = policy.secondReminderAfterDays !== null && policy.secondReminderAfterDays !== undefined
    ? automation.REVIEW_REMINDER_BEFORE_SECOND_WORDING : automation.REVIEW_REMINDER_WORDING;
  return {
    sms: policy.reminderSms ?? shipped.sms,
    emailSubject: policy.reminderEmailSubject ?? shipped.emailSubject,
    emailBody: policy.reminderEmailBody ?? shipped.emailBody,
  };
}

/**
 * Turn the one reminder on, with how many days to wait, or off, and change
 * the words it goes in. Its own call so that a screen can change it without
 * sending the whole service standard back. Either may be left out and stays
 * as it was; `wording: null` puts back the words we ship. Words are checked by
 * core's `checkReviewWording`, the rules the shipped words are held to.
 */
export async function setReminders(ctx: ServiceContext, input: {
  afterDays?: number | null | undefined;
  wording?: rv.ReviewWording | null | undefined;
  secondAfterDays?: number | null | undefined;
  followUpAfterDays?: number | null | undefined;
}) {
  await guardedWrite(ctx, "settings:write", async (tx) => {
    for (const days of [input.afterDays, input.secondAfterDays, input.followUpAfterDays]) {
      if (days === undefined) continue;
      const verdict = rv.checkReminderDays(days);
      if (!verdict.ok) throw new ConflictError(verdict.reason);
    }
    /**
     * Line ends as a browser posts them (a text box sends CRLF) are kept as the
     * plain newlines everything else is written with, so the shipped words
     * saved back from the screen are recognised as ours.
     */
    const lines = (text: string) => text.replace(/\r\n?/g, "\n").trim();
    const typed = input.wording ? {
      sms: lines(input.wording.sms),
      emailSubject: lines(input.wording.emailSubject),
      emailBody: lines(input.wording.emailBody),
    } : null;
    if (typed) {
      const words = rv.checkReviewWording(typed);
      if (!words.ok) throw new ConflictError(words.reason);
    }
    /** The shipped words typed back in are the shipped words, so later improvements to them still reach this company. */
    /**
     * Either shipped version: the screen shows the one without "the only
     * reminder" while a second reminder is on, and saving it back is still
     * keeping our words, not writing the company's own.
     */
    const isShipped = (shipped: rv.ReviewWording) => typed !== null && typed.sms === shipped.sms
      && typed.emailSubject === shipped.emailSubject && typed.emailBody === shipped.emailBody;
    const own = typed && !isShipped(automation.REVIEW_REMINDER_WORDING)
      && !isShipped(automation.REVIEW_REMINDER_BEFORE_SECOND_WORDING) ? typed : null;

    const before = await policyFor(tx, ctx.actor.organizationId);
    /**
     * A second reminder follows the first, so it needs the first on. Asked for
     * without it, it is refused in words; turning the first off turns the
     * second off with it, rather than leaving a setting that does nothing.
     */
    const firstAfter = input.afterDays !== undefined ? input.afterDays : before.reminderAfterDays;
    if (input.secondAfterDays !== undefined && input.secondAfterDays !== null && firstAfter === null) {
      throw new ConflictError("A second reminder follows the first. Turn the first reminder on, then the second.");
    }
    const secondAfter = firstAfter === null ? null
      : input.secondAfterDays !== undefined ? input.secondAfterDays : before.secondReminderAfterDays;
    const [after] = await tx.update(schema.reviewPolicy)
      .set({
        ...(input.afterDays !== undefined ? { reminderAfterDays: input.afterDays } : {}),
        secondReminderAfterDays: secondAfter,
        ...(input.followUpAfterDays !== undefined ? { followUpAfterDays: input.followUpAfterDays } : {}),
        ...(input.wording !== undefined ? {
          reminderSms: own?.sms ?? null,
          reminderEmailSubject: own?.emailSubject ?? null,
          reminderEmailBody: own?.emailBody ?? null,
        } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.reviewPolicy.id, before.id)).returning();
    const kept = (row: typeof before) => ({
      reminderAfterDays: row.reminderAfterDays,
      secondReminderAfterDays: row.secondReminderAfterDays, followUpAfterDays: row.followUpAfterDays,
      reminderSms: row.reminderSms, reminderEmailSubject: row.reminderEmailSubject, reminderEmailBody: row.reminderEmailBody,
    });
    await audit(tx, ctx, "review_policy.reminders_set", "review_policy", before.id, kept(before), kept(after!));
  });
  return reminders(ctx);
}

/* ------------------------------------------------------------- platforms */

/**
 * What the operator says a platform allows.
 *
 * Declared, never shipped. A table of a platform's rules compiled into this
 * product is somebody else's rule, it goes stale without anybody noticing,
 * and in a self hosted deployment it can never be corrected in the field. An
 * operator who read Google's policy this quarter knows more than a constant
 * written last year.
 */
export async function platforms(tx: Database, organizationId: string): Promise<rv.PlatformPolicy[]> {
  const rows = await tx.select().from(schema.reviewPlatform)
    .where(and(
      eq(schema.reviewPlatform.organizationId, organizationId),
      eq(schema.reviewPlatform.active, true),
      isNull(schema.reviewPlatform.deletedAt),
    ));

  return rows.map((row) => ({
    platform: row.platform,
    prohibits: row.prohibits as rv.Prohibition[],
    note: row.note,
  }));
}

export const listPlatforms = (ctx: ServiceContext) =>
  guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.reviewPlatform)
      .where(and(
        eq(schema.reviewPlatform.organizationId, ctx.actor.organizationId),
        isNull(schema.reviewPlatform.deletedAt),
      ))
      .orderBy(schema.reviewPlatform.displayName);
    return rows.map((row) => ({
      platform: row.platform,
      displayName: row.displayName,
      reviewUrl: row.reviewUrl,
      prohibits: row.prohibits,
      note: row.note,
      active: row.active,
    }));
  });

export async function setPlatform(
  ctx: ServiceContext,
  input: { platform: string; displayName: string; reviewUrl?: string | null; prohibits: string[]; note: string },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const existing = await platforms(tx, ctx.actor.organizationId);
    const proposed: rv.PlatformPolicy[] = [
      ...existing.filter((p) => p.platform !== input.platform.trim()),
      {
        platform: input.platform.trim(),
        prohibits: input.prohibits as rv.Prohibition[],
        note: input.note,
      },
    ];

    /**
     * The whole catalogue is checked, not the one row, because the failures
     * core looks for are properties of the SET: a duplicated platform,
     * where the answer would depend on read order, and a prohibition
     * outside the declared list, which would silently match nothing and
     * read as permission.
     */
    const verdict = rv.checkPlatformPolicies(proposed);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const [row] = await tx.insert(schema.reviewPlatform).values({
      organizationId: ctx.actor.organizationId,
      platform: input.platform.trim(),
      displayName: input.displayName,
      reviewUrl: input.reviewUrl ?? null,
      prohibits: input.prohibits,
      note: input.note,
      active: true,
    }).onConflictDoUpdate({
      target: [schema.reviewPlatform.organizationId, schema.reviewPlatform.platform],
      targetWhere: isNull(schema.reviewPlatform.deletedAt),
      set: {
        displayName: input.displayName,
        reviewUrl: input.reviewUrl ?? null,
        prohibits: input.prohibits,
        note: input.note,
        active: true,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "review_platform.set", "review_platform", row!.id, null, row!);
    return { platform: row!.platform, displayName: row!.displayName, prohibits: row!.prohibits };
  });
}

/* --------------------------------------------------------- asking, or not */

/**
 * Everything the decision is allowed to know about a job, and nothing else.
 *
 * This function is the enforcement point in the service layer. It builds
 * core's `JobFacts` from named columns, so adding an input to the decision
 * means editing this function and core's `REQUEST_INPUTS` list, in a file
 * whose header explains which inputs are forbidden and why.
 *
 * There is no satisfaction score to read even if somebody wanted to.
 */
export async function factsFor(
  tx: Database,
  organizationId: string,
  jobId: string,
  /**
   * The company chose to ask about every finished job that owes nothing (the
   * review automation's "Which jobs to ask about"). A job with no invoice owes
   * nothing, so it reads as settled; without this it reads as unpaid, which is
   * what the ask has always done.
   */
  options: { uninvoicedIsSettled?: boolean } = {},
): Promise<rv.JobFacts> {
  const [job] = await tx.select({
    id: schema.job.id,
    customerId: schema.job.customerId,
    status: schema.job.status,
    completedAt: schema.job.completedAt,
    parentJobId: schema.job.parentJobId,
  }).from(schema.job)
    .where(and(eq(schema.job.id, jobId), eq(schema.job.organizationId, organizationId)))
    .limit(1);
  if (!job) throw new NotFoundError("Job");

  /**
   * The technician's departure, not the office closing the job. Those
   * differ by up to a day in practice, and asking about a visit somebody
   * remembers from this morning is a different message from asking about
   * one they have to look up.
   */
  const [lastVisit] = await tx.select({ completedAt: schema.visit.completedAt })
    .from(schema.visit)
    .where(and(
      eq(schema.visit.jobId, jobId),
      inArray(schema.visit.status, ["completed", "completed_after_cancellation"]),
    ))
    .orderBy(desc(schema.visit.completedAt))
    .limit(1);

  /**
   * EVERY live invoice on the job, not the first one found: a deposit that is
   * paid beside a final bill that is not is an unpaid job. A voided invoice
   * owes nothing and says nothing about whether the job was paid. A credit
   * note that settled an invoice has taken its balance to nothing, so a job
   * settled that way reads as paid, as it always has.
   */
  const invoices = await tx.select({ balance: schema.invoice.balance })
    .from(schema.invoice)
    .where(and(
      eq(schema.invoice.organizationId, organizationId),
      eq(schema.invoice.jobId, jobId),
      isNull(schema.invoice.deletedAt),
      sql`${schema.invoice.status} <> 'void'`,
    ));

  /**
   * A callback is a job whose parent is this one. Unresolved means it is
   * still open: the customer's defining experience of this work is that we
   * came back, and it is not over.
   */
  const [callback] = await tx.select({
    id: schema.job.id,
    completedAt: schema.job.completedAt,
    status: schema.job.status,
  }).from(schema.job)
    .where(and(
      eq(schema.job.organizationId, organizationId),
      eq(schema.job.parentJobId, jobId),
    ))
    .orderBy(desc(schema.job.createdAt))
    .limit(1);

  const [customer] = await tx.select({
    doNotService: schema.customer.doNotService,
  }).from(schema.customer)
    .where(eq(schema.customer.id, job.customerId)).limit(1);

  const [consent] = await tx.select({ id: schema.communicationConsent.id })
    .from(schema.communicationConsent)
    .where(and(
      eq(schema.communicationConsent.organizationId, organizationId),
      eq(schema.communicationConsent.customerId, job.customerId),
      eq(schema.communicationConsent.purpose, "marketing"),
      eq(schema.communicationConsent.state, "revoked"),
    )).limit(1);

  const sent = await tx.select({
    jobId: schema.reviewRequest.jobId,
    sentAt: schema.reviewRequest.sentAt,
  }).from(schema.reviewRequest)
    .where(and(
      eq(schema.reviewRequest.organizationId, organizationId),
      eq(schema.reviewRequest.customerId, job.customerId),
      eq(schema.reviewRequest.state, "sent"),
    ));

  /**
   * An open complaint is an obligation somebody raised against this job and
   * has not closed. The obligation table is the product's one primitive for
   * that, so this reads it rather than inventing a second flag.
   */
  const [complaint] = await tx.select({ id: schema.obligation.id })
    .from(schema.obligation)
    .where(and(
      eq(schema.obligation.organizationId, organizationId),
      eq(schema.obligation.entityType, "job"),
      eq(schema.obligation.entityId, jobId),
      inArray(schema.obligation.state, ["open", "breached"]),
    )).limit(1);

  return {
    jobId: job.id,
    customerId: job.customerId,
    /**
     * `completedAt`, not `status === "completed"`.
     *
     * The status moves ON past completed: a job whose invoice has been paid
     * reads `paid`, and a status check would withhold every paid job as
     * "not completed", which is every job this feature exists for. The
     * timestamp is the fact about the work; the status is where the job is
     * in its life.
     */
    completed: job.completedAt !== null,
    paid: invoices.length > 0
      ? invoices.every((invoice) => Number(invoice.balance) <= 0)
      : options.uninvoicedIsSettled === true,
    technicianLeftAt: lastVisit?.completedAt ?? null,
    callback: callback
      ? { resolvedAt: callback.completedAt }
      : null,
    complaintOpen: Boolean(complaint),
    /**
     * Two different things, both meaning do not ask. A revoked marketing
     * consent is the customer's instruction; `doNotService` is the
     * company's own decision about the relationship, and asking somebody
     * for a public review after deciding not to work for them again is a
     * bad idea for reasons nobody needs explained.
     */
    optedOut: Boolean(consent) || Boolean(customer?.doNotService),
    requests: sent
      .filter((r): r is { jobId: string; sentAt: Date } => r.sentAt !== null)
      .map((r) => ({ jobId: r.jobId, sentAt: r.sentAt })),
  };
}

export interface RequestOutcome {
  jobId: string;
  asked: boolean;
  requestId: string | null;
  sendAt: Date | null;
  readyNow: boolean;
  withheld: string | null;
  explanation: string | null;
  /** True when the reason will pass on its own: an unpaid invoice, a callback still open. */
  clearsOnItsOwn: boolean | null;
}

/**
 * Decide whether to ask about one job, and write down the answer either way.
 *
 * A WITHHELD request is a row, and that is not bookkeeping. A system that
 * only records what it sent cannot answer "why did this customer never get
 * asked", and the answer is almost always worth knowing: an open complaint
 * nobody closed, a callback still running, an opt out from three years ago.
 */
export async function requestFor(ctx: ServiceContext, input: { jobId: string; platform?: string }) {
  return guardedWrite(ctx, "review:respond", (tx) =>
    requestWithin(tx, ctx.actor.organizationId, input));
}

/**
 * The decision and its row, inside a transaction the caller holds.
 *
 * Split out so the automation step that asks for a review uses this exact
 * function rather than a copy of it. A second implementation of "may we ask"
 * is the one that eventually forgets the cooldown or the open complaint, and
 * the step is the one that would send without a person looking.
 */
export async function requestWithin(
  tx: Database,
  organizationId: string,
  input: {
    jobId: string; platform?: string | undefined;
    /** Who is to send it when it is queued: the office's request goes by the worker, an automation's by its own run. */
    source?: "office" | "automation" | undefined;
    /** See `factsFor`: a job with no invoice owes nothing. Set by the automation's "every finished job" choice. */
    uninvoicedIsSettled?: boolean | undefined;
  },
  now: Date = new Date(),
): Promise<RequestOutcome> {
  const policyRow = await policyFor(tx, organizationId);
  const facts = await factsFor(tx, organizationId, input.jobId, { uninvoicedIsSettled: input.uninvoicedIsSettled === true });
  const decision = rv.decideRequest(facts, requestPolicy(policyRow), now);

  /**
   * The platform's own rules are checked BEFORE anything is queued, not
   * before it is sent. A queued request that will be refused at send time
   * is a row somebody sees on a screen as pending, and pending is a
   * promise.
   */
  if (decision.ask && input.platform) {
    const catalogue = rv.checkPlatformPolicies(await platforms(tx, organizationId));
    if (!catalogue.ok) throw new ConflictError(catalogue.reason);

    const verdict = rv.checkPlannedRequest({
      platform: input.platform,
      /**
       * All four declared as false, and none of them is a field somebody
       * can set. This product does not offer an incentive, does not send
       * in bulk, does not ask on site, and sends under the company's own
       * identity. They are passed explicitly rather than omitted so that
       * a future feature which changed one of them has to come here and
       * say so.
       */
      offersIncentive: false,
      isBulkSend: false,
      askedOnSite: false,
      sentByThirdParty: false,
    }, catalogue.byPlatform);

    if (!verdict.ok) throw new ConflictError(verdict.reason);
  }

  const values = decision.ask
    ? {
        organizationId: organizationId,
        jobId: facts.jobId,
        customerId: facts.customerId,
        platform: input.platform ?? null,
        source: input.source ?? "office",
        state: "queued" as const,
        sendAt: decision.sendAt,
        withheldReason: null,
        withheldDetail: null,
      }
    : {
        organizationId: organizationId,
        jobId: facts.jobId,
        customerId: facts.customerId,
        platform: input.platform ?? null,
        source: input.source ?? "office",
        state: "withheld" as const,
        sendAt: null,
        withheldReason: decision.withheld,
        withheldDetail: decision.explanation,
      };

  const [row] = await tx.insert(schema.reviewRequest).values(values)
    .onConflictDoUpdate({
      /**
       * One request per job, and re-deciding updates it. A job whose
       * invoice has since been paid should stop reading "withheld:
       * unpaid" the moment somebody asks again.
       */
      target: [schema.reviewRequest.jobId],
      targetWhere: isNull(schema.reviewRequest.deletedAt),
      set: { ...values, updatedAt: new Date() },
    }).returning();

  return decision.ask
    ? {
        jobId: facts.jobId, asked: true, requestId: row!.id,
        sendAt: decision.sendAt, readyNow: decision.readyNow,
        withheld: null, explanation: null, clearsOnItsOwn: null,
      }
    : {
        jobId: facts.jobId, asked: false, requestId: row!.id,
        sendAt: null, readyNow: false,
        withheld: decision.withheld, explanation: decision.explanation,
        clearsOnItsOwn: decision.clearsOnItsOwn,
      };
}

/**
 * The link a request sends somebody to, for one platform the operator
 * declared. Null when the platform is not declared, is switched off, or was
 * declared without a link, which are three ways of having nowhere to send them.
 */
export async function reviewUrlFor(tx: Database, platform: string): Promise<string | null> {
  const [row] = await tx.select({ reviewUrl: schema.reviewPlatform.reviewUrl })
    .from(schema.reviewPlatform)
    .where(and(
      eq(schema.reviewPlatform.platform, platform),
      eq(schema.reviewPlatform.active, true),
      isNull(schema.reviewPlatform.deletedAt),
    )).limit(1);
  return row?.reviewUrl ?? null;
}

/** Requests whose send window has arrived. What a worker drains. */
export async function due(ctx: ServiceContext, now = new Date()) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const rows = await tx.select().from(schema.reviewRequest)
      .where(and(
        eq(schema.reviewRequest.organizationId, ctx.actor.organizationId),
        eq(schema.reviewRequest.state, "queued"),
        lte(schema.reviewRequest.sendAt, now),
      ))
      .orderBy(asc(schema.reviewRequest.sendAt));

    return rows.map((row) => ({
      id: row.id, jobId: row.jobId, customerId: row.customerId,
      platform: row.platform, sendAt: row.sendAt,
    }));
  });
}

/** Mark one as gone out. */
export async function markSent(ctx: ServiceContext, input: { id: string; messageId?: string }) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const [row] = await tx.update(schema.reviewRequest).set({
      state: "sent",
      sentAt: new Date(),
      messageId: input.messageId ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.reviewRequest.id, input.id),
      eq(schema.reviewRequest.organizationId, ctx.actor.organizationId),
      eq(schema.reviewRequest.state, "queued"),
    )).returning();

    if (!row) {
      throw new ConflictError(
        "That request is not queued, so it has either gone already or was withheld. Sending it now would be the second ask.",
      );
    }
    return { id: row.id, sentAt: row.sentAt };
  });
}

/** Why people were not asked, grouped. A worklist rather than a log. */
export async function withheld(ctx: ServiceContext, limit = 50) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const rows = await tx.select({
      reason: schema.reviewRequest.withheldReason,
      count: sql<number>`count(*)::int`,
    }).from(schema.reviewRequest)
      .where(and(
        eq(schema.reviewRequest.organizationId, ctx.actor.organizationId),
        eq(schema.reviewRequest.state, "withheld"),
      ))
      .groupBy(schema.reviewRequest.withheldReason)
      .orderBy(desc(sql`count(*)`))
      .limit(limit);

    return rows.map((row) => ({ reason: row.reason ?? "unknown", count: row.count }));
  });
}

/* ------------------------------------------------- reviews that exist */

type ReviewRow = typeof schema.review.$inferSelect;

/**
 * A star review for core's averages. A recommendation is not a rating, so it
 * is left out of every average: callers filter with `isStars` first.
 */
const toCore = (row: ReviewRow): rv.Review => ({
  id: row.id,
  platform: row.platform,
  rating: row.rating ?? 0,
  postedAt: row.postedAt,
  respondedAt: row.respondedAt,
  ...(row.technicianId ? { technicianId: row.technicianId } : {}),
});

const isStars = (row: ReviewRow): boolean => row.kind === "stars" && row.rating !== null;
const isRecommendation = (row: ReviewRow): row is ReviewRow & { recommends: boolean } =>
  row.kind === "recommendation" && row.recommends !== null;

/**
 * The same review for the reply queue, which decides what is OWED, not what is
 * counted: a recommendation is given the rating a yes or a no is owed as
 * (`rv.owedRating`, five and one), so a no still starts the clock for a reply
 * and a call exactly as a one star does, while it stays out of the averages.
 */
const toWork = (row: ReviewRow): rv.Review => ({
  ...toCore(row),
  rating: isRecommendation(row) ? rv.owedRating(row.recommends) : row.rating ?? 0,
});

export interface ReviewInput {
  platform: string;
  /** One to five, for a star review. */
  rating?: number | undefined;
  /** For a recommendation, a yes or a no. Exactly one of this and `rating`. */
  recommends?: boolean | undefined;
  postedAt: Date;
  externalId?: string | null;
  authorName?: string | null;
  body?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  technicianId?: string | null;
}

/**
 * Record a review that exists in the world.
 *
 * Entered by hand, or read from a Google Business Profile listing by the
 * review sync, which calls this so both arrive the same way. The hand path
 * is not a placeholder: every platform without a connector is typed in, and
 * a company with forty reviews and a work list telling them which three are
 * owed a reply is better off than one waiting for an API.
 *
 * The recovery clock is set HERE, on the way in, rather than computed on
 * every read. It is the one derived value in this file that is stored, and
 * the reason is that it is a commitment rather than a calculation: "somebody
 * will ring this customer today" is a promise made at the moment the review
 * landed, and recomputing it from a policy somebody edited last week would
 * quietly move a deadline that was already missed.
 */
export async function record(ctx: ServiceContext, input: ReviewInput) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const recommendation = input.recommends !== undefined;
    if (recommendation && input.rating !== undefined) {
      throw new ConflictError("A recommendation is a yes or a no and has no rating. Send one or the other.");
    }
    if (!recommendation && (input.rating === undefined || !Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) {
      throw new ConflictError("A rating is a whole number from one to five, or a recommendation is a yes or a no.");
    }
    const kind = recommendation ? "recommendation" as const : "stars" as const;
    const stars = recommendation ? null : input.rating!;
    const recommends = recommendation ? input.recommends! : null;
    /** What the reply and the call are owed as: the rating, or five for a yes and one for a no. */
    const owed = recommendation ? rv.owedRating(recommends!) : stars!;

    const policyRow = await policyFor(tx, ctx.actor.organizationId);
    const recovery = rv.routeReply(
      {
        jobId: input.jobId ?? "",
        customerId: input.customerId ?? "",
        rating: owed,
        receivedAt: input.postedAt,
      },
      {
        recoverAtOrBelow: policyRow.recoverAtOrBelow,
        sameDayAtOrBelow: policyRow.sameDayAtOrBelow,
      },
    );

    const recoveryDueAt = recovery.recover
      ? new Date(input.postedAt.getTime() + (recovery.urgency === "same_day" ? 8 : 32) * 3600_000)
      : null;

    const [row] = await tx.insert(schema.review).values({
      organizationId: ctx.actor.organizationId,
      platform: input.platform,
      externalId: input.externalId ?? null,
      kind,
      rating: stars,
      recommends,
      authorName: input.authorName ?? null,
      body: input.body ?? null,
      postedAt: input.postedAt,
      jobId: input.jobId ?? null,
      customerId: input.customerId ?? null,
      technicianId: input.technicianId ?? null,
      recoveryDueAt,
    }).onConflictDoUpdate({
      /**
       * Keyed on the platform's own id, so an import can run twice. A
       * review edited by its author is the same review, and inserting a
       * second copy would double it in every average.
       */
      target: [schema.review.organizationId, schema.review.platform, schema.review.externalId],
      targetWhere: sql`external_id is not null and deleted_at is null`,
      set: {
        kind,
        rating: stars,
        recommends,
        authorName: input.authorName ?? null,
        body: input.body ?? null,
        postedAt: input.postedAt,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "review.recorded", "review", row!.id, null, {
      platform: input.platform, kind, rating: stars, recommends,
      recoveryOwed: recovery.recover,
    });

    return {
      id: row!.id,
      kind,
      rating: row!.rating,
      recommends: row!.recommends,
      /**
       * Returned with the row, because the caller who just typed in a one
       * star needs to be told a phone call is owed and by when. Leaving
       * them to notice it on a list later is how the call does not happen.
       */
      recoveryOwed: recovery.recover,
      recoveryUrgency: recovery.recover ? recovery.urgency : null,
      because: recovery.because,
      recoveryDueAt,
    };
  });
}

/**
 * The reply queue, in the order somebody should work it.
 *
 * Overdue first, most overdue at the top, then by deadline, then by the
 * band's priority. Sorting by rating alone would put a week old one star
 * below a fresh one; sorting by date alone would put a five star from this
 * morning above a one star from last night.
 *
 * Answered reviews are not on it. A queue that keeps showing finished work
 * is a queue people stop reading.
 */
export async function workList(ctx: ServiceContext, now = new Date()) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const policyRow = await policyFor(tx, ctx.actor.organizationId);

    const rows = await tx.select().from(schema.review)
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        isNull(schema.review.respondedAt),
        isNull(schema.review.deletedAt),
      ));

    const byId = new Map(rows.map((row) => [row.id, row]));
    /**
     * With the company's holiday list, so a one star posted the evening
     * before Christmas is not shown as overdue on the twenty sixth: the
     * clock does not run on a closed date, and a short day counts its own
     * hours.
     */
    const policy = { ...responsePolicy(policyRow), holidays: await loadHolidays(tx, ctx.actor.organizationId) };
    const items = rv.responseWorkList(rows.map(toWork), policy, now);

    return items.map((item) => {
      const row = byId.get(item.review.id)!;
      return {
        id: item.review.id,
        platform: item.review.platform,
        kind: row.kind,
        /** Null for a recommendation, whose place in the queue is as a five for a yes and a one for a no. */
        rating: row.rating,
        recommends: row.recommends,
        authorName: row.authorName,
        /** The text, because a work list showing only a star count sends somebody to another tab. */
        body: row.body,
        postedAt: item.review.postedAt,
        dueAt: item.dueAt,
        reason: item.reason,
        overdueBy: item.overdueBy,
        overdue: item.overdueBy > 0,
        /** A separate act from the public reply, and a separate deadline. */
        recoveryDueAt: row.recoveryDueAt,
        recoveredAt: row.recoveredAt,
      };
    });
  });
}

/**
 * Post a reply.
 *
 * Refuses an empty one, and refuses one that is identical to a reply already
 * posted under another review. Templated replies are in core's PROHIBITIONS
 * with the reason stated plainly: it is visible to any prospect who scrolls,
 * which is the real cost, and some platforms treat identical replies at
 * volume as automated activity.
 */
export async function respond(ctx: ServiceContext, input: { id: string; body: string }) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const [existing] = await tx.select().from(schema.review)
      .where(and(
        eq(schema.review.id, input.id),
        eq(schema.review.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!existing) throw new NotFoundError("Review");
    if (existing.respondedAt) {
      throw new ConflictError("That review already has a reply. Editing it is a change on the platform, not here.");
    }

    const body = input.body.trim();
    if (body.length < 10) {
      throw new ConflictError("A reply that short says nothing. It is the only part of that conversation the company controls.");
    }

    const catalogue = rv.checkPlatformPolicies(await platforms(tx, ctx.actor.organizationId));
    if (!catalogue.ok) throw new ConflictError(catalogue.reason);

    const [duplicate] = await tx.select({ id: schema.review.id })
      .from(schema.review)
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        eq(schema.review.responseBody, body),
      )).limit(1);

    const verdict = rv.checkPlannedReply(
      { platform: existing.platform, isTemplated: Boolean(duplicate) },
      catalogue.byPlatform,
    );
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const [row] = await tx.update(schema.review).set({
      respondedAt: new Date(),
      responseBody: body,
      respondedByUserId: ctx.actor.userId,
      /**
       * A review read from a connected listing has its reply posted back to
       * the listing by the review sync, which this marks it as waiting for.
       * One typed in by hand is still answered on the platform by hand.
       */
      ...(existing.connectionId && existing.externalId ? { replyState: "pending", replyError: null } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.review.id, input.id)).returning();

    await audit(tx, ctx, "review.responded", "review", input.id, null, { platform: existing.platform });
    return { id: row!.id, respondedAt: row!.respondedAt };
  });
}

/**
 * Somebody rang the customer.
 *
 * Recorded separately from the public reply, because they are different
 * acts: one is a conversation and the other is what the next prospect
 * reads. A product that treated them as one would let a good public reply
 * close out a phone call that never happened.
 */
export async function markRecovered(ctx: ServiceContext, input: { id: string; note?: string }) {
  return guardedWrite(ctx, "review:respond", async (tx) => {
    const [row] = await tx.update(schema.review).set({
      recoveredAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.review.id, input.id),
      eq(schema.review.organizationId, ctx.actor.organizationId),
      isNull(schema.review.recoveredAt),
    )).returning();

    if (!row) throw new NotFoundError("Review awaiting a call");
    await audit(tx, ctx, "review.recovered", "review", input.id, null, { note: input.note ?? null });
    return { id: row.id, recoveredAt: row.recoveredAt };
  });
}

/**
 * Three views of the same reviews, because no single number is honest.
 *
 * The mean is what every platform shows and is wrong about TIME: a shop run
 * badly two years ago reads as mediocre forever. The recency weighted view
 * fixes that and is wrong about VOLUME: with a dozen reviews it swings on
 * one. The lower bound is wrong about how good you are, deliberately and
 * always downward, which is what makes it safe to sort by and unsafe to
 * print on a van.
 *
 * Every caveat travels with its number. A rating shown without one is the
 * thing that gets painted on the side of a truck.
 */
export async function rating(ctx: ServiceContext, input: { platform?: string } = {}) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const policyRow = await policyFor(tx, ctx.actor.organizationId);

    const rows = await tx.select().from(schema.review)
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        isNull(schema.review.deletedAt),
        ...(input.platform ? [eq(schema.review.platform, input.platform)] : []),
      ));

    return {
      /** Star reviews only: a recommendation is not a rating and would make every yes a perfect score. */
      ...rv.summarise(
        rows.filter(isStars).map(toCore),
        { halfLifeDays: policyRow.halfLifeDays },
        new Date(),
      ),
      recommendations: rv.recommendationShare(rows.filter(isRecommendation)),
    };
  });
}

/**
 * Technicians in order, by the confidence aware figure.
 *
 * The lower bound rather than the mean, because the mean puts a technician
 * with two five stars above one with two hundred reviews averaging 4.8, and
 * the person reading this is deciding who to send to a difficult customer.
 */
export async function byTechnician(ctx: ServiceContext) {
  return guardedRead(ctx, "review:respond", async (tx) => {
    const policyRow = await policyFor(tx, ctx.actor.organizationId);
    const rows = await tx.select({
      review: schema.review,
      name: schema.technician.displayName,
    }).from(schema.review)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.review.technicianId))
      .where(and(
        eq(schema.review.organizationId, ctx.actor.organizationId),
        isNull(schema.review.deletedAt),
      ));

    const groups = new Map<string, { name: string; reviews: rv.Review[] }>();
    for (const { review: row, name } of rows) {
      /** A technician is ranked by their star reviews; a recommendation is not a rating. */
      if (!isStars(row)) continue;
      const key = row.technicianId!;
      const entry = groups.get(key) ?? { name, reviews: [] };
      entry.reviews.push(toCore(row));
      groups.set(key, entry);
    }

    const ranked = rv.rankByConfidence(
      [...groups.entries()].map(([key, entry]) => ({ key, reviews: entry.reviews })),
      { halfLifeDays: policyRow.halfLifeDays },
      new Date(),
    );

    return ranked.map((group) => ({
      technicianId: group.key,
      name: groups.get(group.key)?.name ?? "",
      count: group.view.count,
      mean: group.view.mean,
      recentMean: group.view.recentMean,
      /**
       * The number the ordering uses, published under its own name rather
       * than as "rating". It is deliberately lower than the real rating and
       * must never be shown to a customer as one.
       */
      confidence: group.view.confidence,
      caveats: group.view.caveats,
    }));
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  setReviewPolicy: (ctx: ServiceContext, input: PolicyInput) => setPolicy(ctx, input),
  getReviewPolicy: async (ctx: ServiceContext) => ({ policy: await currentPolicy(ctx) }),
  getReviewReminders: (ctx: ServiceContext) => reminders(ctx),
  setReviewReminders: (ctx: ServiceContext, input: {
    afterDays?: number | null | undefined;
    wording?: rv.ReviewWording | null | undefined;
    secondAfterDays?: number | null | undefined;
    followUpAfterDays?: number | null | undefined;
  }) => setReminders(ctx, input),

  listReviewPlatforms: async (ctx: ServiceContext): Promise<{
    platforms: {
      platform: string; displayName: string; reviewUrl: string | null;
      prohibits: string[]; note: string; active: boolean;
    }[];
  }> => ({ platforms: await listPlatforms(ctx) }),

  setReviewPlatform: (ctx: ServiceContext, input: {
    platform: string; displayName: string;
    reviewUrl?: string | null | undefined;
    prohibits: string[]; note: string;
  }): Promise<{ platform: string; displayName: string; prohibits: string[] }> =>
    setPlatform(ctx, { ...input, reviewUrl: input.reviewUrl ?? null }),

  requestReview: (ctx: ServiceContext, input: { jobId: string; platform?: string | undefined }) =>
    requestFor(ctx, {
      jobId: input.jobId,
      ...(input.platform ? { platform: input.platform } : {}),
    }),

  listDueRequests: async (ctx: ServiceContext): Promise<{
    requests: {
      id: string; jobId: string; customerId: string;
      platform: string | null; sendAt: Date | null;
    }[];
  }> => ({ requests: await due(ctx) }),

  markRequestSent: (ctx: ServiceContext, input: { id: string; messageId?: string | undefined }) =>
    markSent(ctx, {
      id: input.id,
      ...(input.messageId ? { messageId: input.messageId } : {}),
    }),

  listWithheld: async (ctx: ServiceContext): Promise<{
    reasons: { reason: string; count: number }[];
  }> => ({ reasons: await withheld(ctx) }),

  recordReview: (ctx: ServiceContext, input: {
    platform: string; rating?: number | undefined; recommends?: boolean | undefined; postedAt: string;
    externalId?: string | null | undefined;
    authorName?: string | null | undefined;
    body?: string | null | undefined;
    jobId?: string | null | undefined;
    customerId?: string | null | undefined;
    technicianId?: string | null | undefined;
  }): Promise<{
    id: string; kind: "stars" | "recommendation"; rating: number | null; recommends: boolean | null; recoveryOwed: boolean;
    recoveryUrgency: string | null; because: string; recoveryDueAt: Date | null;
  }> => record(ctx, {
    platform: input.platform,
    rating: input.rating,
    recommends: input.recommends,
    postedAt: new Date(input.postedAt),
    externalId: input.externalId ?? null,
    authorName: input.authorName ?? null,
    body: input.body ?? null,
    jobId: input.jobId ?? null,
    customerId: input.customerId ?? null,
    technicianId: input.technicianId ?? null,
  }),

  getReviewWorkList: async (ctx: ServiceContext): Promise<{
    items: {
      id: string; platform: string; kind: "stars" | "recommendation"; rating: number | null; recommends: boolean | null;
      authorName: string | null; body: string | null;
      postedAt: Date; dueAt: Date; reason: string;
      overdueBy: number; overdue: boolean;
      recoveryDueAt: Date | null; recoveredAt: Date | null;
    }[];
  }> => ({ items: await workList(ctx) }),

  respondToReview: (ctx: ServiceContext, input: { id: string; body: string }) =>
    respond(ctx, input),

  markReviewRecovered: (ctx: ServiceContext, input: { id: string; note?: string | undefined }) =>
    markRecovered(ctx, {
      id: input.id,
      ...(input.note ? { note: input.note } : {}),
    }),

  getRating: (ctx: ServiceContext, input: { platform?: string | undefined }): Promise<{
    count: number; mean: number | null; recentMean: number | null;
    confidence: number | null; method: string;
    caveats: { mean: string; recentMean: string; confidence: string };
  }> => rating(ctx, input.platform ? { platform: input.platform } : {}),

  getRatingByTechnician: async (ctx: ServiceContext): Promise<{
    technicians: {
      technicianId: string; name: string; count: number;
      mean: number | null; recentMean: number | null; confidence: number | null;
      caveats: { mean: string; recentMean: string; confidence: string };
    }[];
  }> => ({ technicians: await byTechnician(ctx) }),
} as const;
