import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, can, notices as rules, time, type Actor } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, inTenant, ConflictError, type ServiceContext } from "./context";
import { memberActor } from "./session";
import { quietHoursFor } from "./comms-send";
import { publicBaseUrl } from "./setup-tokens";
import { stillOpen } from "./staff-notices";
import * as email from "./email";
import { within } from "./workflow-schedule";

/**
 * KEEPING NOTICES USEFUL: A DAILY DIGEST, AND READ ONES TIDIED AWAY
 *
 * Two jobs the worker does for notices (M34) beside raising and sending
 * them, both off until somebody asks.
 *
 * THE DAILY DIGEST is a person's own choice, on `/me`: one email a day
 * listing the notices on their bell they have not read and can still open.
 * Sent at the company's morning hour, which is when its quiet hours end (8
 * without them), because that is already when the company starts texting
 * people, or at an hour of their own they chose on `/me`, inside the
 * company's day and outside its quiet hours. Nothing goes on a day nothing is unread. It is decided once per
 * company day: the row is claimed for the day in the same transaction that
 * puts the email in the company's outbox, so two workers, or a pass run
 * twice, send one. Through `email.queue` like every other email, so a
 * company with no email connected, or an address on the do-not-email list,
 * is a reason written on the row in words, not a silent nothing. The list is
 * asked the way the bell asks: each notice opened again with the person's
 * permissions now, so the email never names a record they can no longer
 * open.
 *
 * HOW LONG READ NOTICES ARE KEPT is the company's, on Settings, and kept for
 * good until it chooses a number of days, which is what has always happened.
 * The worker then removes notices read longer ago than that, and ones the
 * person switched off in the app (nobody was ever going to read those)
 * raised longer ago. Never an unread one on the bell. And never a licence or
 * talk notice the worker could still raise again, because the row is how it
 * remembers it told somebody: core's `raisedAgainWithinDays` holds those
 * back until their record can no longer raise them (a year and a few days
 * for a licence, a week and two days for a talk), whatever the setting says.
 * A notice's sends go with it. One audit line per sweep says how many.
 */

/** What the worker acts as here: it reads notices and queues the digest, nothing else. */
function workerActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "notice-upkeep" };
}

/** How many unread a digest asks about; it lists twenty of them and counts the rest. */
const UNREAD_ASKED = 200;
/** Notices removed per transaction, so a first sweep over years of them never holds a long lock. */
const SWEEP_BATCH = 1000;
/** Each company is looked at this often, per worker; a digest a few minutes after the hour is on time. */
export const UPKEEP_EVERY_MS = 5 * 60_000;

/* ----------------------------------------------------------- the setting */

export async function keepDaysWithin(tx: Database, organizationId: string): Promise<number | null> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const saved = ((row?.settings ?? {}) as Record<string, unknown>)["readNotices"] as { keepDays?: unknown } | undefined;
  return rules.keepReadDays(saved?.keepDays);
}

/** How long the company keeps read notices. `settings:read`. Null keeps them for good, the default. */
export function keeping(ctx: ServiceContext): Promise<{ keepDays: number | null }> {
  return guardedRead(ctx, "settings:read", async (tx) => ({ keepDays: await keepDaysWithin(tx, ctx.actor.organizationId) }));
}

/**
 * Keep read notices so many days, or for good with null. `settings:write`,
 * audited. The worker removes what the new number allows from its next
 * visit; a shorter number never brings back what a longer one removed.
 */
export function setKeeping(ctx: ServiceContext, input: { keepDays: number | null }): Promise<{ keepDays: number | null }> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const problem = rules.keepReadProblem(input.keepDays);
    if (problem) throw new ConflictError(problem);
    const before = await keepDaysWithin(tx, ctx.actor.organizationId);
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ readNotices: { keepDays: input.keepDays } })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    if (before !== input.keepDays) {
      await audit(tx, ctx, "organization.read_notices_kept", "organization", ctx.actor.organizationId,
        { keepDays: before }, { keepDays: input.keepDays });
    }
    return { keepDays: input.keepDays };
  });
}

/* --------------------------------------------------------- the worker */

export interface UpkeepResult {
  organizationId: string;
  /** Digests put in the company's outbox. */
  digested: number;
  /** People whose digest was decided today with nothing to send, or could not go, with the reason on their row. */
  notSent: number;
  /** Read notices removed. */
  removed: number;
  error?: string;
}

const visitedAt = new Map<string, number>();

/** Every company with a digest switched on or read notices to tidy. Each company's failure is its own. */
export async function upkeepPass(
  db: Database,
  options: { now?: (() => Date) | undefined; only?: readonly string[] | undefined; shouldStop?: (() => boolean) | undefined } = {},
): Promise<UpkeepResult[]> {
  const rows = within(options.only, await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.staff_notice_upkeep_organizations()`,
  ));
  const results: UpkeepResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const now = (options.now ?? (() => new Date()))();
    if (now.getTime() - (visitedAt.get(row.organization_id) ?? 0) < UPKEEP_EVERY_MS) continue;
    try {
      results.push(await upkeepFor(db, row.organization_id, now));
      visitedAt.set(row.organization_id, now.getTime());
    } catch (error) {
      results.push({ organizationId: row.organization_id, digested: 0, notSent: 0, removed: 0, error: (error as Error).message });
    }
  }
  return results;
}

/** The digests due and the sweep, for one company. */
export async function upkeepFor(db: Database, organizationId: string, now: Date = new Date()): Promise<UpkeepResult> {
  const result: UpkeepResult = { organizationId, digested: 0, notSent: 0, removed: 0 };
  await sendDigests(db, organizationId, now, result);
  result.removed = await sweep(db, organizationId, now);
  return result;
}

async function sendDigests(db: Database, organizationId: string, now: Date, result: UpkeepResult): Promise<void> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  const due = await inTenant(ctx, async (tx) => {
    const quiet = await quietHoursFor(tx, organizationId, now);
    const today = time.dateIn(now, quiet.zone);
    if (!rules.digestDue({ today, localHour: quiet.localHour, lastOn: null, quiet: quiet.window })) return null;
    const people = await tx.select({ id: schema.staffNoticeDigest.id, hour: schema.staffNoticeDigest.hour })
      .from(schema.staffNoticeDigest)
      .where(and(
        eq(schema.staffNoticeDigest.enabled, true),
        or(isNull(schema.staffNoticeDigest.lastOn), lt(schema.staffNoticeDigest.lastOn, today)),
      ))
      .limit(500);
    /** Each person at their own hour, where they chose one still inside the company's day. */
    const due = people.filter((p) => rules.digestDue({
      today, localHour: quiet.localHour, lastOn: null, quiet: quiet.window, hour: p.hour,
    }));
    return { today, ids: due.map((p) => p.id) };
  });
  if (!due) return;
  for (const id of due.ids) {
    try {
      const sent = await digestOne(ctx, id, due.today, now);
      if (sent === true) result.digested += 1;
      else if (sent === false) result.notSent += 1;
    } catch (error) {
      /** Rolled back with its claim, so the next visit tries again. The message, never the notices. */
      console.error(`[notices] digest for one person in ${organizationId} failed: ${(error as Error).message}`);
    }
  }
}

/**
 * One person's digest, in one transaction: claimed for the day, decided, and
 * queued or written down as why not. True when queued, false when decided
 * with nothing sent, null when somebody else had already claimed it.
 */
async function digestOne(ctx: ServiceContext, id: string, today: string, now: Date): Promise<boolean | null> {
  const organizationId = ctx.actor.organizationId;
  return inTenant(ctx, async (tx) => {
    const table = schema.staffNoticeDigest;
    const [claimed] = await tx.update(schema.staffNoticeDigest).set({ lastOn: today, updatedAt: now })
      .where(and(eq(table.id, id), eq(table.enabled, true), or(isNull(table.lastOn), lt(table.lastOn, today))))
      .returning({ userId: table.userId });
    if (!claimed) return null;
    const outcome = async (words: string, sent: boolean) => {
      await tx.update(schema.staffNoticeDigest).set({ lastOutcome: words, ...(sent ? { lastSentAt: now } : {}), updatedAt: now })
        .where(eq(table.id, id));
      return sent;
    };

    /** The person as their own session would be, so the list is what their bell would show now. */
    const actor = await memberActor(tx, organizationId, claimed.userId);
    if (!actor || actor.readOnly || !can(actor, "profile:own")) return outcome("Not sent: they do not work here now.", false);

    const rows = await tx.select().from(schema.staffNotice)
      .where(and(
        eq(schema.staffNotice.userId, claimed.userId),
        eq(schema.staffNotice.inApp, true),
        isNull(schema.staffNotice.readAt),
      ))
      .orderBy(sql`${schema.staffNotice.createdAt} desc`).limit(UNREAD_ASKED);
    const unread = await stillOpen(tx, actor, rows);
    if (unread.length === 0) return outcome("Nothing was unread, so nothing was sent.", false);

    const [person] = await tx.execute<{ email: string | null }>(
      sql`select email from app.organization_people() where user_id = ${claimed.userId} limit 1`,
    );
    const address = person?.email ? email.normalizeAddress(person.email) : "";
    if (!address.includes("@")) return outcome("Not sent: there is no email address to send it to.", false);

    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, organizationId)).limit(1);
    const base = publicBaseUrl();
    const message = rules.digestEmail({
      companyName: org?.name ?? "Your company",
      notices: unread.map((n) => ({
        kindLabel: n.kindLabel, title: n.title, body: n.body, link: base ? `${base}/notices/${n.id}` : null,
      })),
      allLink: base ? `${base}/notices` : null,
      settingsLink: base ? `${base}/me#notices` : null,
    });
    const sender: ServiceContext = { actor: { ...ctx.actor, grants: ["message:send"] }, db: tx };
    const queued = await email.queue(sender, {
      to: address, subject: message.subject, text: message.text, purpose: "transactional",
    });
    if (!queued.queued) return outcome(`Not sent: ${queued.explanation}`.slice(0, 500), false);
    return outcome(`Sent, listing ${unread.length} unread.`, true);
  });
}

/**
 * Remove what the company's setting allows, a batch per transaction. The
 * rule in SQL is core's `sweepable`, kind by kind; the integration test
 * holds the two to the same answer.
 */
async function sweep(db: Database, organizationId: string, now: Date): Promise<number> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  let removed = 0;
  for (;;) {
    const batch = await inTenant(ctx, async (tx) => {
      const keepDays = await keepDaysWithin(tx, organizationId);
      if (keepDays === null) return 0;
      const n = schema.staffNotice;
      const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
      const held = rules.NOTICE_KINDS.filter((kind) => rules.raisedAgainWithinDays(kind) > 0);
      /** The earliest each held kind may go, by when it was raised. */
      const notBefore = held.length === 0 ? sql`true` : sql.join(held.map((kind) =>
        sql`(${n.kind} <> ${kind} or ${n.createdAt} <= ${new Date(now.getTime() - rules.raisedAgainWithinDays(kind) * 86_400_000).toISOString()}::timestamptz)`),
      sql` and `);
      const gone = await tx.execute<{ id: string }>(sql`
        delete from public.staff_notice where id in (
          select ${n.id} from ${n}
           where ${n.organizationId} = ${organizationId}
             and coalesce(${n.readAt}, case when not ${n.inApp} then ${n.createdAt} end) <= ${cutoff.toISOString()}::timestamptz
             and ${notBefore}
           limit ${SWEEP_BATCH}
        )
        returning id`);
      if (gone.length > 0) {
        await audit(tx, ctx, "staff_notice.swept", "organization", organizationId, null, { removed: gone.length, keepDays });
      }
      return gone.length;
    });
    removed += batch;
    if (batch < SWEEP_BATCH) return removed;
  }
}

export const handlers = {
  getReadNoticeKeeping: (ctx: ServiceContext) => keeping(ctx),
  setReadNoticeKeeping: (ctx: ServiceContext, input: { keepDays: number | null }) => setKeeping(ctx, input),
} as const;
