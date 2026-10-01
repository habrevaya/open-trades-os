import { randomBytes, createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError, timezoneOf,
  type ServiceContext,
} from "./context";
import { createCalendarProvider, type CalendarEvent } from "../calendar/provider";

/**
 * A TECHNICIAN'S DAY, IN THE CALENDAR THEY ALREADY HAVE
 *
 * `calendar` has been in the capability enum since the first migration with
 * nothing behind it. This is the whole of it: a URL carrying an unguessable
 * token, returning the visits somebody is assigned, which Google Calendar,
 * Apple Calendar, Outlook and every phone subscribe to natively. There is no
 * vendor, no OAuth, no app review and nothing to be refused.
 *
 * THE FEED IS A BEARER CREDENTIAL AND IT IS TREATED AS ONE. Whoever holds
 * the URL sees the visits, for as long as it is live, with no session and no
 * second factor. That is what makes it work on a phone and it is the entire
 * risk, so: the token is minted here and shown once, only its hash is
 * stored, every fetch is stamped on the row so an unused feed is visible,
 * and revoking is one call that takes effect on the next fetch.
 *
 * WHAT THE FEED SHOWS OF A CUSTOMER, WHICH IS THE DECISION IN THIS FILE
 *
 * A calendar subscription is collected by a phone, and that phone may be
 * signed into a personal Google or Apple account, shared with a spouse,
 * backed up, read out by an assistant and shown on a lock screen. So the
 * question is not "may this technician see the customer's details", which
 * they plainly may and do all day in the field app. It is "which of those
 * details should travel into an account this company does not control".
 *
 *   THE ADDRESS GOES IN, as LOCATION. Without it the feed does not do the
 *   one thing it is for: the technician taps the event and the phone offers
 *   to navigate. A calendar of times with no places is a worse version of a
 *   list they already have.
 *
 *   THE CUSTOMER'S NAME GOES IN. Leaving it out buys nothing, and pretending
 *   otherwise would be the kind of gesture this codebase treats as a defect:
 *   the street address is already there, and an address identifies a
 *   household far more precisely than a surname does. What it costs is the
 *   technician knowing who to ask for at the door.
 *
 *   THE PHONE NUMBER STAYS OUT, and this is the line. It is the one field
 *   that is directly actionable by whoever ends up holding it: a leaked feed
 *   or a shared family calendar becomes a list of names, addresses and
 *   numbers, which is a cold-call list and a spoofing list. It is also the
 *   field the technician does not need in order to ARRIVE, which is what a
 *   calendar is for. Ringing the customer happens in the field app, where
 *   the consent rules and the recording policy are enforced, and the
 *   description carries a link straight to the job so getting there is one
 *   tap rather than a search.
 *
 *   NOTHING ABOUT MONEY GOES IN. No price, no balance, no margin. A
 *   technician's permissions already withhold cost, and a feed is read
 *   without any permissions at all, so anything here would be a way around
 *   every field level rule in the product.
 *
 * WHO MAY MINT ONE, AND THE COMPANY WIDE FEED
 *
 * A technician minting a feed of their OWN day needs `visit:read`, which
 * they hold, because that is exactly what the feed contains and nothing
 * more. Minting one over somebody ELSE'S day additionally needs
 * `visit:dispatch`: arranging other people's days is what that permission
 * governs, and a standing read of somebody's movements is the same
 * authority pointed the other way.
 *
 * A company wide feed exists, and minting one additionally needs
 * `integration:write`. It is deliberately the integration permission rather
 * than a dispatch one, because a company feed is every customer address the
 * company serves, in one file, behind one URL, with no session: that is a
 * standing export to an outside system, which is the decision
 * `integration:write` is for. A dispatcher can run the board without being
 * able to hand the whole schedule to an outside calendar.
 */

/* ---------------------------------------------------------------- the token */

/**
 * How much of the day either side of now a feed covers.
 *
 * Bounded, because an unbounded feed grows forever: a company three years in
 * would serve every visit it has ever scheduled on every poll, to every
 * phone, every hour. A fortnight back is enough to look up what happened on
 * a job last week; sixty days forward is past the end of any schedule a
 * trades company has actually committed to.
 */
export const WINDOW_BACK_DAYS = 14;
export const WINDOW_FORWARD_DAYS = 60;

/** How often a client is asked to come back. Hourly is what the big clients honour in practice. */
export const REFRESH_MINUTES = 60;

/**
 * The token in the URL.
 *
 * 32 bytes from the system CSPRNG, base64url, which is 256 bits of entropy
 * in 43 characters. The same shape and the same reasoning as the lead
 * webhook's token: it is the only thing standing between the internet and
 * this data, so it is not a slug, not an id, and not short enough to be
 * worth guessing at.
 */
const newToken = () => randomBytes(32).toString("base64url");

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Enough to tell two feeds apart on a screen, and useless for reaching either. */
const hintOf = (token: string) => token.slice(-6);

export const feedPath = (token: string) => `/api/calendar/${token}`;

/* --------------------------------------------------------------- minting */

export interface FeedInput {
  scope: "technician" | "company";
  /** Required for a technician feed, refused on a company one. */
  technicianId?: string | undefined;
  label?: string | undefined;
}

function shape(row: typeof schema.calendarFeed.$inferSelect) {
  return {
    id: row.id,
    scope: row.scope,
    technicianId: row.technicianId,
    label: row.label,
    /** The last characters of the token. Never the token. */
    hint: row.hint,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    lastFetchedAt: row.lastFetchedAt,
    lastFetchedBy: row.lastFetchedBy,
    createdAt: row.createdAt,
  };
}

/**
 * The technician record behind this account, if there is one.
 *
 * Separate from holding `visit:read`, which an owner and an accountant also
 * hold without having a route. A feed for an account that is not a
 * technician would be an empty calendar, so it is refused with a sentence
 * rather than minted and left to disappoint.
 */
async function technicianFor(tx: Database, ctx: ServiceContext): Promise<string | null> {
  const [row] = await tx.select({ id: schema.technician.id })
    .from(schema.technician)
    .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
    .where(and(
      eq(schema.technician.organizationId, ctx.actor.organizationId),
      eq(schema.membership.userId, ctx.actor.userId),
    )).limit(1);
  return row?.id ?? null;
}

/**
 * Mint a feed, and hand the URL over once.
 *
 * The URL comes back from here and from `rotate`, and from nowhere else.
 * There is no read path for it, for the same reason the lead webhook's
 * signing secret has none: a URL a list endpoint will hand over on request
 * leaks through every screen, log and support transcript that ever shows a
 * feed, and this particular URL needs no credential behind it.
 */
export async function create(ctx: ServiceContext, input: FeedInput) {
  return guardedWrite(ctx, "visit:read", async (tx) => {
    const technicianId = await resolveSubject(tx, ctx, input);
    const token = newToken();

    const [row] = await tx.insert(schema.calendarFeed).values({
      organizationId: ctx.actor.organizationId,
      scope: input.scope,
      technicianId,
      tokenHash: hashOf(token),
      hint: hintOf(token),
      label: await labelFor(tx, ctx, input, technicianId),
      createdByUserId: ctx.actor.userId,
    }).returning();

    /**
     * The token is NOT in the audit entry, and the hint is. `audit:read` is
     * a much longer list of people than the one who minted this, and an
     * audit log that carries live credentials is a credential store with
     * worse access control than the credential store.
     */
    await audit(tx, ctx, "calendar_feed.created", "calendar_feed", row!.id, null, {
      scope: input.scope, technicianId, hint: row!.hint,
    });

    return {
      ...shape(row!),
      /**
       * Shown once. Append it to this deployment's own public address and
       * subscribe to the result; losing it means rotating, which is the same
       * thing you would do if it leaked.
       */
      feedPath: feedPath(token),
    };
  });
}

/**
 * Which technician's day this feed is for, and whether this actor may have
 * one over it.
 *
 * The three permission rules in the header are enforced here, in one place,
 * because the alternative is each of `create` and `rotate` having its own
 * version and the two drifting.
 */
async function resolveSubject(
  tx: Database, ctx: ServiceContext, input: FeedInput,
): Promise<string | null> {
  if (input.scope === "company") {
    if (input.technicianId) {
      throw new ConflictError(
        "A company feed covers everybody, so naming a technician on one would be a "
        + "narrower feed wearing a wider label. Ask for a technician feed instead.",
      );
    }
    /**
     * The extra authority, asserted rather than assumed. A company feed is
     * every customer address the company serves, in one file, behind one URL
     * that needs no session.
     */
    assertCan(ctx.actor, "integration:write");
    return null;
  }

  const own = await technicianFor(tx, ctx);

  if (!input.technicianId || input.technicianId === own) {
    if (!own) {
      throw new ConflictError(
        "This account is not a technician, so a feed of its own day would be an empty "
        + "calendar. A company feed shows everybody's work and needs the integration permission.",
      );
    }
    return own;
  }

  /** Somebody else's day. The same authority that puts work on it. */
  assertCan(ctx.actor, "visit:dispatch");

  const [subject] = await tx.select({ id: schema.technician.id })
    .from(schema.technician)
    .where(and(
      eq(schema.technician.id, input.technicianId),
      eq(schema.technician.organizationId, ctx.actor.organizationId),
    )).limit(1);
  if (!subject) throw new NotFoundError("Technician");
  return subject.id;
}

async function labelFor(
  tx: Database, ctx: ServiceContext, input: FeedInput, technicianId: string | null,
): Promise<string> {
  const given = input.label?.trim();
  if (given) return given;
  if (!technicianId) return "Everybody's visits";

  const [row] = await tx.select({ displayName: schema.technician.displayName })
    .from(schema.technician)
    .where(and(
      eq(schema.technician.id, technicianId),
      eq(schema.technician.organizationId, ctx.actor.organizationId),
    )).limit(1);
  return row ? `${row.displayName}: visits` : "Visits";
}

/**
 * Every feed this account may know about.
 *
 * Your own always. Everybody's if you hold `integration:write`, which is the
 * permission that answers "which standing credentials does this company have
 * pointed at its data", and that question is unanswerable if the list only
 * ever shows the asker's own.
 */
export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const everyone = can(ctx.actor, "integration:write");
    const own = everyone ? null : await technicianFor(tx, ctx);

    const rows = await tx.select().from(schema.calendarFeed)
      .where(and(
        eq(schema.calendarFeed.organizationId, ctx.actor.organizationId),
        everyone
          ? undefined
          : own
            ? eq(schema.calendarFeed.technicianId, own)
            /**
             * Not a technician and not an integration administrator: there
             * is nothing this account could have minted, so it is shown
             * nothing rather than everything.
             */
            : sql`false`,
      ))
      .orderBy(asc(schema.calendarFeed.createdAt));

    return rows.map(shape);
  });
}

async function load(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.calendarFeed)
    .where(and(
      eq(schema.calendarFeed.id, id),
      eq(schema.calendarFeed.organizationId, ctx.actor.organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Calendar feed");
  return row;
}

/**
 * May this account turn this particular feed off, or replace it.
 *
 * Your own, or anybody's with `integration:write`. A technician losing their
 * phone must be able to kill their own feed without finding an
 * administrator, and an administrator must be able to kill one belonging to
 * somebody who has left.
 */
async function assertMayManage(
  tx: Database, ctx: ServiceContext, row: typeof schema.calendarFeed.$inferSelect,
): Promise<void> {
  if (can(ctx.actor, "integration:write")) return;
  const own = await technicianFor(tx, ctx);
  if (own && row.technicianId === own) return;
  throw new ConflictError(
    "That feed is not yours. Turning off somebody else's calendar, or the company one, "
    + "needs the permission to connect and disconnect integrations.",
  );
}

/**
 * Stop it working.
 *
 * Stamped rather than deleted. "This URL used to reach our schedule and was
 * switched off on the fourth" is the question somebody asks after a phone
 * goes missing, and a deleted row answers it with silence.
 */
export async function revoke(ctx: ServiceContext, input: { id: string; reason?: string | undefined }) {
  return guardedWrite(ctx, "visit:read", async (tx) => {
    const before = await load(tx, ctx, input.id);
    await assertMayManage(tx, ctx, before);

    if (before.revokedAt) {
      /** Already off. Not an error: somebody revoking twice is somebody being careful. */
      return { ...shape(before), alreadyRevoked: true as const };
    }

    const [after] = await tx.update(schema.calendarFeed).set({
      revokedAt: new Date(),
      revokedByUserId: ctx.actor.userId,
      revokedReason: input.reason?.trim() ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.calendarFeed.id, input.id)).returning();

    await audit(tx, ctx, "calendar_feed.revoked", "calendar_feed", input.id,
      { hint: before.hint }, { reason: input.reason ?? null });

    return { ...shape(after!), alreadyRevoked: false as const };
  });
}

/**
 * A new URL for the same day, and the old one dead.
 *
 * One call rather than revoke-then-create, for the reason the lead
 * connector's rotation gives: somebody rotating is responding to a worry,
 * and a two step rotation is one somebody can leave half done. The old feed
 * is revoked in the same transaction, so there is never a moment when both
 * URLs work.
 */
export async function rotate(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "visit:read", async (tx) => {
    const before = await load(tx, ctx, input.id);
    await assertMayManage(tx, ctx, before);

    await tx.update(schema.calendarFeed).set({
      revokedAt: before.revokedAt ?? new Date(),
      revokedByUserId: before.revokedByUserId ?? ctx.actor.userId,
      revokedReason: before.revokedReason ?? "Rotated",
      updatedAt: new Date(),
    }).where(eq(schema.calendarFeed.id, input.id));

    const token = newToken();
    const [row] = await tx.insert(schema.calendarFeed).values({
      organizationId: ctx.actor.organizationId,
      scope: before.scope,
      technicianId: before.technicianId,
      tokenHash: hashOf(token),
      hint: hintOf(token),
      label: before.label,
      createdByUserId: ctx.actor.userId,
    }).returning();

    await audit(tx, ctx, "calendar_feed.rotated", "calendar_feed", row!.id,
      { id: before.id, hint: before.hint }, { id: row!.id, hint: row!.hint });

    return { ...shape(row!), feedPath: feedPath(token), replaced: before.id };
  });
}

/* ------------------------------------------------------------ the feed itself */

export interface RenderedFeed {
  body: string;
  contentType: string;
  /** For the Content-Disposition filename, so a downloaded copy is identifiable. */
  label: string;
}

export interface RenderOptions {
  /** The deployment's own public address, for the link back to the job. Omitted means no link. */
  baseUrl?: string | undefined;
  /** What asked for it, for the row's own record of who is collecting it. */
  userAgent?: string | undefined;
  now?: Date | undefined;
  /** Which provider renders it. One today; CalDAV would be the second. */
  provider?: string | undefined;
}

/**
 * Serve one feed.
 *
 * Takes a Database rather than a ServiceContext, like every other path in
 * this codebase that is reached with a secret in a URL instead of a session:
 * at the moment this is called there is no actor and no tenant, and the
 * token is the thing that establishes both. Nothing else about the request
 * is trusted, and nothing in the request chooses which organization is read.
 *
 * Returns null for a token that names nothing, for a revoked one, and for
 * one belonging to a technician who has since been removed. The caller
 * answers all three with the same 404: distinguishing them would turn the
 * endpoint into an oracle for telling a live token from a dead one.
 */
export async function render(
  db: Database,
  token: string,
  options: RenderOptions = {},
): Promise<RenderedFeed | null> {
  const now = options.now ?? new Date();

  /**
   * Compared by hash, so the stored value is useless to anybody who reads
   * the table. The index is on the hash for the same reason: looking a token
   * up by a prefix of itself would put the live value in a query plan.
   */
  const [feed] = await db.select().from(schema.calendarFeed)
    .where(and(
      eq(schema.calendarFeed.tokenHash, hashOf(token)),
      isNull(schema.calendarFeed.revokedAt),
    )).limit(1);

  if (!feed) return null;
  if (feed.scope === "technician" && !feed.technicianId) return null;

  const provider = createCalendarProvider(options.provider ?? "ics_feed");

  const from = new Date(now.getTime() - WINDOW_BACK_DAYS * 864e5);
  const until = new Date(now.getTime() + WINDOW_FORWARD_DAYS * 864e5);

  const events = await eventsFor(db, feed, from, until, options.baseUrl);
  const timezone = await timezoneOf(db, feed.organizationId);

  /**
   * Stamped after the rows are read rather than before, so a fetch that
   * failed halfway does not leave a row claiming it was served.
   */
  await db.update(schema.calendarFeed).set({
    lastFetchedAt: now,
    lastFetchedBy: options.userAgent?.slice(0, 200) ?? null,
    updatedAt: now,
  }).where(eq(schema.calendarFeed.id, feed.id));

  return {
    body: provider.render({
      name: feed.label,
      timezone,
      refreshMinutes: REFRESH_MINUTES,
      events,
    }),
    contentType: provider.contentType,
    label: feed.label,
  };
}

/**
 * The visits a feed covers, as events.
 *
 * One row per visit, guaranteed, and that guarantee is the reason the
 * assignments are fetched separately below rather than joined here. A visit
 * carrying two technicians joined to its assignments is two rows, which
 * becomes two VEVENTs with the same UID, which is precisely the duplicate
 * this whole feature has to avoid. The renderer refuses such a document, so
 * getting this wrong is a failed fetch rather than a doubled calendar, but
 * the right answer is not to produce it.
 */
async function eventsFor(
  db: Database,
  feed: typeof schema.calendarFeed.$inferSelect,
  from: Date,
  until: Date,
  baseUrl: string | undefined,
): Promise<CalendarEvent[]> {
  const mine = feed.technicianId ? await assignedTo(db, feed.technicianId) : undefined;

  const rows = await db.select({
    visit: schema.visit,
    jobId: schema.job.id,
    jobNumber: schema.job.number,
    jobSummary: schema.job.summary,
    jobUpdatedAt: schema.job.updatedAt,
    customerName: schema.customer.name,
    customerUpdatedAt: schema.customer.updatedAt,
    addressLine1: schema.property.addressLine1,
    addressLine2: schema.property.addressLine2,
    city: schema.property.city,
    state: schema.property.state,
    postalCode: schema.property.postalCode,
    propertyUpdatedAt: schema.property.updatedAt,
  })
    .from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
    .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
    .where(and(
      eq(schema.visit.organizationId, feed.organizationId),
      /**
       * A visit with no window is not an appointment yet. It belongs on the
       * unassigned column of the board, and putting it on a calendar would
       * mean inventing a time for it.
       */
      sql`${schema.visit.windowStart} is not null`,
      gte(schema.visit.windowStart, from),
      lte(schema.visit.windowStart, until),
      mine,
    ))
    .orderBy(asc(schema.visit.windowStart));

  const ids = rows.map((row) => row.visit.id);
  const crew = feed.scope === "company" ? await crewLabels(db, rows) : new Map<string, string>();
  const people = feed.scope === "company" && ids.length > 0
    ? await techniciansOn(db, ids)
    : new Map<string, string[]>();

  return rows.map((row) => {
    const visit = row.visit;
    /**
     * The window, or the estimate when there is only a start. A contractor
     * promises "between one and four" and the window is the promise; where
     * there is no end, the duration the office planned is a better answer
     * than an arbitrary hour, and far better than nothing, which would make
     * every visit a zero length event.
     */
    const start = visit.windowStart!;
    const end = visit.windowEnd
      ?? new Date(start.getTime() + visit.estimatedDurationMinutes * 60_000);

    const who = [...(people.get(visit.id) ?? []), ...(crew.get(visit.id) ? [crew.get(visit.id)!] : [])];

    return {
      uid: uidFor(visit.id),
      start,
      end,
      /**
       * The newest change to anything shown below, not only to the visit.
       * Moving the appointment, renaming the job and correcting the address
       * all change what the phone should say, and a DTSTAMP that only
       * tracked the first leaves the other two invisible to a client that
       * compares versions before redrawing.
       */
      lastModified: newest([
        visit.updatedAt, row.jobUpdatedAt, row.customerUpdatedAt, row.propertyUpdatedAt,
      ]),
      created: visit.createdAt,
      status: statusOf(visit.status),
      summary: summaryFor(row.customerName, row.jobSummary, who),
      location: addressOf(row),
      description: descriptionFor({
        jobNumber: row.jobNumber,
        jobSummary: row.jobSummary,
        customerName: row.customerName,
        status: visit.status,
        who,
        jobUrl: baseUrl ? `${baseUrl.replace(/\/$/, "")}/jobs/${row.jobId}` : null,
      }),
      url: baseUrl ? `${baseUrl.replace(/\/$/, "")}/jobs/${row.jobId}` : null,
    } satisfies CalendarEvent;
  });
}

/**
 * Whose visits, for a technician feed.
 *
 * Both ways a person can be on a visit: named on it through
 * `visit_assignment`, which is how `technician_dispatch` work is scheduled,
 * and through a crew they belong to, which is how `crew_production` work is.
 * A feed that only knew about the first would be empty for a crew that
 * installs all day, and nothing on the screen would say why.
 *
 * Written as EXISTS rather than a join, because a join against assignments
 * multiplies a two-handed visit into two rows and two rows become two
 * identical events.
 */
async function assignedTo(db: Database, technicianId: string): Promise<SQL | undefined> {
  const crews = await db.select({ crewId: schema.crewMember.crewId })
    .from(schema.crewMember)
    .where(eq(schema.crewMember.technicianId, technicianId));

  const assigned = sql`exists (
    select 1 from public.visit_assignment va
    where va.visit_id = ${schema.visit.id} and va.technician_id = ${technicianId}
  )`;

  if (crews.length === 0) return assigned;
  return or(assigned, inArray(schema.visit.crewId, crews.map((c) => c.crewId)));
}

/** Who is on each visit, for the company feed, in one query rather than per row. */
async function techniciansOn(db: Database, visitIds: string[]): Promise<Map<string, string[]>> {
  const rows = await db.select({
    visitId: schema.visitAssignment.visitId,
    displayName: schema.technician.displayName,
  })
    .from(schema.visitAssignment)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    .where(inArray(schema.visitAssignment.visitId, visitIds))
    .orderBy(asc(schema.technician.displayName));

  const out = new Map<string, string[]>();
  for (const row of rows) out.set(row.visitId, [...(out.get(row.visitId) ?? []), row.displayName]);
  return out;
}

/** And the crew, for the work that is dispatched to one rather than to a person. */
async function crewLabels(
  db: Database,
  rows: { visit: typeof schema.visit.$inferSelect }[],
): Promise<Map<string, string>> {
  const crewIds = [...new Set(rows.map((r) => r.visit.crewId).filter((id): id is string => Boolean(id)))];
  if (crewIds.length === 0) return new Map();

  const crews = await db.select({ id: schema.crew.id, name: schema.crew.name })
    .from(schema.crew)
    .where(inArray(schema.crew.id, crewIds));
  const byId = new Map(crews.map((c) => [c.id, c.name]));

  const out = new Map<string, string>();
  for (const row of rows) {
    const name = row.visit.crewId ? byId.get(row.visit.crewId) : undefined;
    if (name) out.set(row.visit.id, name);
  }
  return out;
}

/**
 * The UID, and the constant in it.
 *
 * The visit's own id, which is a uuid and is stable for the life of the
 * visit, plus a FIXED suffix. The suffix is not built from `PUBLIC_URL` or
 * from the request's host, and that is the whole point: a deployment that
 * moves from a tunnel to a real domain, or sits behind two names, would
 * otherwise issue a different UID for the same visit, and every subscribed
 * client would treat the whole calendar as new. The technician's phone would
 * quietly accumulate a second copy of every appointment.
 */
const uidFor = (visitId: string) => `${visitId}@visits.opentradesos`;

const newest = (dates: readonly (Date | null)[]): Date =>
  dates.reduce<Date>((latest, at) => (at && at > latest ? at : latest), new Date(0));

/**
 * What a client should do about this event.
 *
 * A cancelled visit is EMITTED, as CANCELLED, rather than dropped from the
 * feed. Most clients do remove an event that disappears, and some keep it,
 * and the difference is a technician driving to a job that was called off.
 * An explicit cancellation with a higher SEQUENCE is the only form every
 * client agrees about.
 *
 * `completed_after_cancellation` is confirmed, not cancelled: the work
 * happened. It is the one status where the name points the wrong way.
 */
function statusOf(status: string): CalendarEvent["status"] {
  if (status === "cancelled" || status === "no_show") return "CANCELLED";
  if (status === "unassigned" || status === "scheduled") return "TENTATIVE";
  return "CONFIRMED";
}

function summaryFor(customerName: string, jobSummary: string, who: readonly string[]): string {
  const subject = `${customerName}: ${jobSummary}`;
  return who.length > 0 ? `${subject} (${who.join(", ")})` : subject;
}

/**
 * The address, as one line.
 *
 * Assembled here rather than by the formatter, because what belongs in a
 * LOCATION is a product decision and escaping it is a format one. The commas
 * in it are ordinary text and the formatter escapes them; left raw they
 * would turn one address into a list of addresses.
 */
function addressOf(row: {
  addressLine1: string | null; addressLine2: string | null;
  city: string | null; state: string | null; postalCode: string | null;
}): string | null {
  const parts = [
    row.addressLine1,
    row.addressLine2,
    [row.city, row.state].filter(Boolean).join(", "),
    row.postalCode,
  ].filter((part): part is string => Boolean(part && part.trim() !== ""));
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The body of the event.
 *
 * No phone number, for the reason set out at the top of this file, and the
 * absence is stated rather than left as a silence: a technician who looks
 * for the number and finds nothing should be told where it is instead of
 * concluding the feed is broken.
 */
function descriptionFor(input: {
  jobNumber: string | number | null;
  jobSummary: string;
  customerName: string;
  status: string;
  who: readonly string[];
  jobUrl: string | null;
}): string {
  const lines = [
    input.jobNumber ? `Job ${input.jobNumber}` : null,
    input.jobSummary,
    `For ${input.customerName}`,
    input.who.length > 0 ? `On it: ${input.who.join(", ")}` : null,
    `Status: ${input.status.replace(/_/g, " ")}`,
    input.jobUrl ? `Open the job: ${input.jobUrl}` : null,
    "The customer's phone number is deliberately not in this feed. It is on the job, "
    + "because a calendar syncs to accounts and devices this company does not control.",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  createCalendarFeed: (ctx: ServiceContext, input: {
    scope: "technician" | "company";
    technicianId?: string | undefined;
    label?: string | undefined;
  }) => create(ctx, input),

  listCalendarFeeds: async (ctx: ServiceContext) => ({ feeds: await list(ctx) }),

  revokeCalendarFeed: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    revoke(ctx, input),

  rotateCalendarFeed: (ctx: ServiceContext, input: { id: string }) => rotate(ctx, input),
} as const;
