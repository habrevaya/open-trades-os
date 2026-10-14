import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  SYSTEM_USER_ID, can, comms, field, notices as rules, time, type Actor,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { memberActor } from "./session";
import * as scoped from "./people-scope";
import { quietHoursFor } from "./comms-send";
import { senderFor } from "./phone-numbers";
import { providerFor as smsProviderFor } from "./comms-outbox";
import { publicBaseUrl } from "./setup-tokens";
import { forgetToken } from "./push";
import { within } from "./workflow-schedule";
import { readerFor } from "../secrets/store";
import { ExpoPushProvider, type PushProvider, type PushTicket } from "../push/provider";
import type { MessagingProvider } from "../comms/provider";

/**
 * TELLING THE COMPANY'S OWN PEOPLE
 *
 * Staff were told things by email, when the company had email connected, or
 * not at all. This is the channel for them: a notice is one sentence about one
 * record for one person, shown on the bell in the app, sent to the phone app
 * for somebody who has it, and texted to their own mobile when they turned
 * that on themselves.
 *
 * ONE WAY IN. `raiseWithin` is how every part of the product tells somebody
 * something, inside the transaction that made the thing worth telling: the
 * escalation, the order waiting, the expense decided. So the notice exists if
 * and only if the fact does, and a crash between them leaves neither.
 *
 * NEVER ABOUT A RECORD THEY CANNOT OPEN. The person's actor is built the way
 * their own session would be (`memberActor`), and the record is opened with
 * it, permission and scope both, before anything is written. Where it cannot
 * be opened, nothing is raised: the notice would be a way of learning that an
 * order exists, or what somebody else's expense was for. The bell asks again
 * when it lists them, so a person whose role was narrowed since stops seeing
 * what they can no longer open.
 *
 * WHERE IT GOES IS THE PERSON'S CHOICE, per kind, on `/me`: in the app and on
 * the phone unless they switch either off, and by text only when they turned
 * texts on with their own number, which is a consent of their own and not a
 * customer's (`staff_text_consent`).
 *
 * SENT BY THE WORKER, NEVER IN THE REQUEST. Raising writes rows; `noticePass`
 * hands the phone ones to the push service and the text ones to the carrier,
 * claimed first so two workers never send one twice, with the network never
 * called inside a transaction, as the technician's push pass does.
 */

/* ---------------------------------------------------------- what about */

/** The record a notice is about. Its page is worked out per person by `openFor`. */
export type About =
  | { type: "task"; id: string }
  | { type: "purchase_order"; id: string }
  | { type: "connected_app"; id: string }
  | { type: "safety_meeting"; id: string }
  | { type: "expense"; id: string }
  | { type: "person_certification"; id: string }
  | { type: "technician_skill"; id: string };

const ABOUT_TYPES = new Set<About["type"]>([
  "task", "purchase_order", "connected_app", "safety_meeting", "expense", "person_certification", "technician_skill",
]);

/**
 * Where this person opens this record, or null when they cannot.
 *
 * Asked with the person's own actor, the same permissions and the same scope
 * their screens use, so "can they open it" has the answer the page itself
 * would give. A record that is gone reads as null too: a notice about it has
 * nothing to open.
 */
export async function openFor(tx: Database, actor: Actor, about: About): Promise<string | null> {
  switch (about.type) {
    case "task": {
      if (!can(actor, "task:read")) return null;
      const [row] = await tx.select({ id: schema.task.id }).from(schema.task)
        .where(eq(schema.task.id, about.id)).limit(1);
      return row ? `/tasks/${row.id}` : null;
    }
    case "purchase_order": {
      if (!can(actor, "po:read")) return null;
      const [row] = await tx.select({ id: schema.purchaseOrder.id }).from(schema.purchaseOrder)
        .where(and(eq(schema.purchaseOrder.id, about.id), isNull(schema.purchaseOrder.deletedAt))).limit(1);
      return row ? `/purchasing/${row.id}` : null;
    }
    case "connected_app": {
      /** The request's page is `settings:read`, and saying yes on it `integration:write`; only somebody who can do both is asked. */
      if (!can(actor, "settings:read") || !can(actor, "integration:write")) return null;
      const [row] = await tx.select({ id: schema.connectedApp.id }).from(schema.connectedApp)
        .where(eq(schema.connectedApp.id, about.id)).limit(1);
      return row ? `/settings/apps/requests/${row.id}` : null;
    }
    case "safety_meeting": {
      /** Their own line on the sheet, signed on their own day, and nobody else's. */
      if (!can(actor, "field:sync") || !actor.technicianId) return null;
      const [row] = await tx.select({ id: schema.safetyMeetingAttendee.id }).from(schema.safetyMeetingAttendee)
        .where(and(
          eq(schema.safetyMeetingAttendee.meetingId, about.id),
          eq(schema.safetyMeetingAttendee.technicianId, actor.technicianId),
        )).limit(1);
      return row ? "/my-day" : null;
    }
    case "expense": {
      /** Their own, on their own page. Whoever decides reads it on `/timesheets`, and is not who this tells. */
      if (!can(actor, "expense:own") || !actor.technicianId) return null;
      const [row] = await tx.select({ technicianId: schema.expense.technicianId }).from(schema.expense)
        .where(eq(schema.expense.id, about.id)).limit(1);
      return row && row.technicianId === actor.technicianId ? "/me/expenses" : null;
    }
    case "person_certification":
    case "technician_skill": {
      const [row] = about.type === "person_certification"
        ? await tx.select({ technicianId: schema.personCertification.technicianId }).from(schema.personCertification)
          .where(eq(schema.personCertification.id, about.id)).limit(1)
        : await tx.select({ technicianId: schema.technicianSkill.technicianId }).from(schema.technicianSkill)
          .where(eq(schema.technicianSkill.id, about.id)).limit(1);
      if (!row) return null;
      /** Their own licence, on their own record. */
      if (row.technicianId === actor.technicianId) return can(actor, "profile:own") ? "/me" : null;
      /** Somebody else's, on that person's page, for whoever may read people and reaches this one. */
      if (!can(actor, "user:read")) return null;
      const [person] = await tx.select({ membershipId: schema.technician.membershipId }).from(schema.technician)
        .where(and(
          eq(schema.technician.id, row.technicianId),
          scoped.recordPeople({ actor, db: tx }),
        )).limit(1);
      return person ? `/people/${person.membershipId}` : null;
    }
    default: {
      const unhandled: never = about;
      return unhandled;
    }
  }
}

/* ---------------------------------------------------------------- raise */

export interface RaiseInput {
  organizationId: string;
  /** Who is told. */
  userId: string;
  kind: rules.NoticeKind;
  /** What raised it, unique per person. The same key twice tells them once. */
  key: string;
  title: string;
  body?: string | null | undefined;
  about: About;
}

export type RaiseOutcome =
  | { told: true; noticeId: string; channels: ("in_app" | "push" | "text")[] }
  | { told: false; reason: string };

/**
 * Tell one person one thing, inside the caller's transaction.
 *
 * Returns why not rather than throwing, like a send does: a notice that
 * cannot be raised (the person left, cannot open the record, was told
 * already) is never a reason to undo the escalation, the decision or the
 * order it is about.
 */
export async function raiseWithin(tx: Database, input: RaiseInput): Promise<RaiseOutcome> {
  if (input.userId === SYSTEM_USER_ID) return { told: false, reason: "Nobody to tell." };

  /** Cheap first: a worker looking at the same licence on every pass stops here. */
  const [already] = await tx.select({ id: schema.staffNotice.id }).from(schema.staffNotice)
    .where(and(
      eq(schema.staffNotice.organizationId, input.organizationId),
      eq(schema.staffNotice.userId, input.userId),
      eq(schema.staffNotice.sourceKey, input.key),
    )).limit(1);
  if (already) return { told: false, reason: "They were told already." };

  const actor = await memberActor(tx, input.organizationId, input.userId);
  if (!actor || actor.readOnly) return { told: false, reason: "They do not work here now." };
  /** Notices are read and switched on their own page; somebody without one has nowhere to read them. */
  if (!can(actor, "profile:own")) return { told: false, reason: "Their role has no page of their own to read notices on." };
  const href = await openFor(tx, actor, input.about);
  if (!href) return { told: false, reason: "They cannot open the record it is about." };

  const saved = await tx.select().from(schema.staffNoticeSetting)
    .where(and(eq(schema.staffNoticeSetting.userId, input.userId), eq(schema.staffNoticeSetting.kind, input.kind)));
  const switches = rules.switchesFor(saved, input.kind);

  const [notice] = await tx.insert(schema.staffNotice).values({
    organizationId: input.organizationId,
    userId: input.userId,
    kind: input.kind,
    sourceKey: input.key.slice(0, 300),
    title: input.title.trim().slice(0, 300),
    body: input.body?.trim().slice(0, 1000) || null,
    entityType: input.about.type,
    entityId: input.about.id,
    href,
    inApp: switches.inApp,
  }).onConflictDoNothing().returning({ id: schema.staffNotice.id });
  if (!notice) return { told: false, reason: "They were told already." };

  const channels: ("in_app" | "push" | "text")[] = switches.inApp ? ["in_app"] : [];

  if (switches.push && actor.technicianId) {
    const phones = await tx.select({ id: schema.device.id }).from(schema.device)
      .where(and(
        eq(schema.device.technicianId, actor.technicianId),
        isNull(schema.device.revokedAt),
        isNotNull(schema.device.pushToken),
      ));
    if (phones.length > 0) {
      await tx.insert(schema.staffNoticeDelivery).values(phones.map((phone) => ({
        organizationId: input.organizationId, noticeId: notice.id, channel: "push" as const,
        deviceId: phone.id, target: phone.id,
      }))).onConflictDoNothing();
      channels.push("push");
    }
  }

  if (switches.text) {
    const consent = await consentWithin(tx, input.userId);
    if (consent?.state === "granted") {
      await tx.insert(schema.staffNoticeDelivery).values({
        organizationId: input.organizationId, noticeId: notice.id, channel: "sms",
        address: consent.address, target: consent.address,
      }).onConflictDoNothing();
      channels.push("text");
    }
  }

  return { told: true, noticeId: notice.id, channels };
}

/* --------------------------------------------------------------- the bell */

export interface NoticeView {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  body: string | null;
  /** Where opening it goes, asked again now. */
  href: string;
  createdAt: string;
  readAt: string | null;
}

/** What the person signed in is, for "me" reads: never a connected app or the system. */
function mustBePerson(ctx: ServiceContext): void {
  if (ctx.actor.userId === SYSTEM_USER_ID || ctx.actor.agentId) {
    throw new ConflictError("Notices are for a person signed in, not for an app or the system.");
  }
}

/**
 * Rows the person may still open, with the page asked again for each. One
 * question per record, however many notices name it.
 */
async function stillOpen(
  tx: Database, actor: Actor, rows: (typeof schema.staffNotice.$inferSelect)[],
): Promise<NoticeView[]> {
  const asked = new Map<string, string | null>();
  const out: NoticeView[] = [];
  for (const row of rows) {
    const key = `${row.entityType}:${row.entityId}`;
    if (!asked.has(key)) {
      asked.set(key, ABOUT_TYPES.has(row.entityType as About["type"])
        ? await openFor(tx, actor, { type: row.entityType, id: row.entityId } as About)
        : null);
    }
    const href = asked.get(key);
    if (!href) continue;
    out.push({
      id: row.id,
      kind: row.kind,
      kindLabel: rules.isNoticeKind(row.kind) ? rules.NOTICE_KIND_WORDS[row.kind].label : row.kind,
      title: row.title,
      body: row.body,
      href,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    });
  }
  return out;
}

/** How many unread the bell counts up to before it says "99+". */
export const UNREAD_CEILING = 99;

/**
 * The signed in person's notices, newest first, and how many are unread.
 *
 * `profile:own`, which every preset holds: a person's notices are theirs, the
 * same class of read as their own record. Only the ones shown in the app; a
 * kind switched off in the app is never on the bell.
 */
export async function list(
  ctx: ServiceContext, input: { limit?: number | undefined; unread?: boolean | undefined } = {},
): Promise<{ notices: NoticeView[]; unread: number }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  return guardedRead(ctx, "profile:own", async (tx) => {
    mustBePerson(ctx);
    const mine = and(
      eq(schema.staffNotice.userId, ctx.actor.userId),
      eq(schema.staffNotice.inApp, true),
    );
    const rows = await tx.select().from(schema.staffNotice)
      .where(and(mine, input.unread ? isNull(schema.staffNotice.readAt) : undefined))
      .orderBy(desc(schema.staffNotice.createdAt)).limit(limit);
    const unreadRows = await tx.select().from(schema.staffNotice)
      .where(and(mine, isNull(schema.staffNotice.readAt)))
      .orderBy(desc(schema.staffNotice.createdAt)).limit(UNREAD_CEILING + 1);
    return {
      notices: await stillOpen(tx, ctx.actor, rows),
      unread: (await stillOpen(tx, ctx.actor, unreadRows)).length,
    };
  });
}

/**
 * Open one: marked read, and the page to go to, asked again now. A notice
 * about a record the person can no longer open reads as not found, as the
 * record itself would.
 */
export async function open(ctx: ServiceContext, input: { id: string }): Promise<{ id: string; href: string }> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    mustBePerson(ctx);
    const [row] = await tx.select().from(schema.staffNotice)
      .where(and(eq(schema.staffNotice.id, input.id), eq(schema.staffNotice.userId, ctx.actor.userId))).limit(1);
    if (!row) throw new NotFoundError("Notice");
    const [view] = await stillOpen(tx, ctx.actor, [row]);
    if (!view) throw new NotFoundError("Notice");
    if (!row.readAt) {
      await tx.update(schema.staffNotice).set({ readAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.staffNotice.id, row.id));
    }
    return { id: row.id, href: view.href };
  });
}

/**
 * Mark some, or all, of the person's own notices read. Ids that are not theirs
 * are ignored rather than refused, so this cannot be used to learn whose a
 * notice id is. Marking something read twice is the first answer again.
 */
export async function markRead(
  ctx: ServiceContext, input: { ids?: string[] | undefined; all?: boolean | undefined },
): Promise<{ marked: number }> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    mustBePerson(ctx);
    if (!input.all && (!input.ids || input.ids.length === 0)) {
      throw new ConflictError("Say which notices, or all of them.");
    }
    const marked = await tx.update(schema.staffNotice).set({ readAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.staffNotice.userId, ctx.actor.userId),
        isNull(schema.staffNotice.readAt),
        input.all ? undefined : inArray(schema.staffNotice.id, input.ids!),
      ))
      .returning({ id: schema.staffNotice.id });
    return { marked: marked.length };
  });
}

/* ------------------------------------------------------------ switches */

/** The words beside the box a person ticks to be texted. Kept on their consent, word for word. */
export const TEXT_AGREEMENT =
  "Text me at this number about the kinds of notice I switch on for texts. "
  + "I can turn texts off here at any time, or reply STOP. Message and data rates may apply.";

export interface NoticeSettingsView {
  kinds: ({ kind: rules.NoticeKind; label: string; description: string } & rules.NoticeSwitches)[];
  texts: { on: boolean; mobile: string | null; since: string | null; agreement: string };
  /** Phones with the app signed in that a push can reach. Zero for somebody not on the board. */
  phones: number;
  /** Whether the company has a registered number that can send texts at all. */
  companyCanText: boolean;
}

async function consentWithin(tx: Database, userId: string) {
  const [row] = await tx.select().from(schema.staffTextConsent)
    .where(and(eq(schema.staffTextConsent.userId, userId), isNull(schema.staffTextConsent.supersededAt)))
    .orderBy(desc(schema.staffTextConsent.capturedAt)).limit(1);
  return row ?? null;
}

async function settingsWithin(tx: Database, ctx: ServiceContext): Promise<NoticeSettingsView> {
  const saved = await tx.select().from(schema.staffNoticeSetting)
    .where(eq(schema.staffNoticeSetting.userId, ctx.actor.userId));
  const consent = await consentWithin(tx, ctx.actor.userId);
  const on = consent?.state === "granted";
  const [phones] = ctx.actor.technicianId
    ? await tx.select({ n: sql<number>`count(*)::int` }).from(schema.device)
      .where(and(
        eq(schema.device.technicianId, ctx.actor.technicianId),
        isNull(schema.device.revokedAt),
        isNotNull(schema.device.pushToken),
      ))
    : [{ n: 0 }];
  const sender = await senderFor(tx, ctx.actor.organizationId, { smsRequired: true });
  return {
    kinds: rules.NOTICE_KINDS.map((kind) => ({ kind, ...rules.NOTICE_KIND_WORDS[kind], ...rules.switchesFor(saved, kind) })),
    texts: {
      on,
      mobile: on ? consent!.address : null,
      since: on ? consent!.capturedAt.toISOString() : null,
      agreement: TEXT_AGREEMENT,
    },
    phones: Number(phones?.n ?? 0),
    companyCanText: Boolean(sender?.smsRegistered),
  };
}

export function settings(ctx: ServiceContext): Promise<NoticeSettingsView> {
  return guardedRead(ctx, "profile:own", (tx) => {
    mustBePerson(ctx);
    return settingsWithin(tx, ctx);
  });
}

/**
 * Save the person's own switches. Only the kinds sent change. A text switch
 * cannot be turned on before texts are: the person gives their number and
 * agrees first, so a switch never says "text me" with nowhere to send it.
 */
export function setSwitches(
  ctx: ServiceContext,
  input: { kinds: ({ kind: string } & rules.NoticeSwitches)[] },
): Promise<NoticeSettingsView> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    mustBePerson(ctx);
    const unknown = input.kinds.filter((k) => !rules.isNoticeKind(k.kind)).map((k) => k.kind);
    if (unknown.length > 0) throw new ConflictError(`There is no kind of notice called ${unknown.join(", ")}.`);
    if (input.kinds.some((k) => k.text)) {
      const consent = await consentWithin(tx, ctx.actor.userId);
      if (consent?.state !== "granted") {
        throw new ConflictError("Turn on texts with your mobile number first, then choose what comes by text.");
      }
    }
    for (const k of input.kinds) {
      await tx.insert(schema.staffNoticeSetting).values({
        organizationId: ctx.actor.organizationId, userId: ctx.actor.userId,
        kind: k.kind, inApp: k.inApp, push: k.push, text: k.text,
      }).onConflictDoUpdate({
        target: [schema.staffNoticeSetting.organizationId, schema.staffNoticeSetting.userId, schema.staffNoticeSetting.kind],
        set: { inApp: k.inApp, push: k.push, text: k.text, updatedAt: new Date() },
      });
    }
    return settingsWithin(tx, ctx);
  });
}

/**
 * Turn texts to the person's own mobile on or off.
 *
 * ONLY THE PERSON, FOR THEMSELVES. There is no office version of this: the
 * number is theirs and so is the say so, and the consent row keeps the words
 * they agreed to, when, and from where.
 *
 * On needs the number and the box ticked. The same number again is the first
 * answer back, not a second consent, and two saves at the same moment leave
 * one current row: the second waits on the first's row, and its insert meets
 * the index on the current row and writes nothing. Off writes the withdrawal and stops every
 * text still waiting to go, so "off" is off now and not after the queue drains.
 */
export function setTexts(
  ctx: ServiceContext,
  input: { on: boolean; mobilePhone?: string | null | undefined; agreed?: boolean | undefined; ipAddress?: string | null | undefined },
): Promise<NoticeSettingsView> {
  return guardedWrite(ctx, "profile:own", async (tx) => {
    mustBePerson(ctx);
    const current = await consentWithin(tx, ctx.actor.userId);
    const now = new Date();

    if (!input.on) {
      if (current?.state !== "granted") return settingsWithin(tx, ctx);
      await tx.update(schema.staffTextConsent).set({ supersededAt: now, updatedAt: now })
        .where(eq(schema.staffTextConsent.id, current.id));
      await tx.insert(schema.staffTextConsent).values({
        organizationId: ctx.actor.organizationId, userId: ctx.actor.userId,
        address: current.address, state: "revoked", capturedAt: now,
        ipAddress: input.ipAddress ?? null,
      }).onConflictDoNothing();
      await stopWaitingTexts(tx, ctx.actor.userId, "They turned texts off before it went.");
      await audit(tx, ctx, "staff_texts.off", "user", ctx.actor.userId, { address: current.address }, null);
      return settingsWithin(tx, ctx);
    }

    const address = comms.phoneAddress(input.mobilePhone ?? "");
    if (!/^\+\d{8,15}$/.test(address)) {
      throw new ConflictError("That does not look like a mobile number. Include the area code.");
    }
    if (input.agreed !== true) {
      throw new ConflictError("Tick the box to say you agree to be texted at this number.");
    }
    if (current?.state === "granted" && current.address === address) return settingsWithin(tx, ctx);

    if (current) {
      await tx.update(schema.staffTextConsent).set({ supersededAt: now, updatedAt: now })
        .where(eq(schema.staffTextConsent.id, current.id));
    }
    /** A new number: anything still waiting for the old one is not sent to it. */
    if (current?.state === "granted") await stopWaitingTexts(tx, ctx.actor.userId, rules.textRefusalWords("number_changed"));
    await tx.insert(schema.staffTextConsent).values({
      organizationId: ctx.actor.organizationId, userId: ctx.actor.userId,
      address, state: "granted", proofText: TEXT_AGREEMENT, capturedAt: now,
      ipAddress: input.ipAddress ?? null,
    }).onConflictDoNothing();
    await audit(tx, ctx, "staff_texts.on", "user", ctx.actor.userId,
      current ? { address: current.address, state: current.state } : null, { address });
    return settingsWithin(tx, ctx);
  });
}

async function stopWaitingTexts(tx: Database, userId: string, reason: string): Promise<void> {
  await tx.update(schema.staffNoticeDelivery).set({ status: "skipped", error: reason, updatedAt: new Date() })
    .where(and(
      eq(schema.staffNoticeDelivery.channel, "sms"),
      inArray(schema.staffNoticeDelivery.status, ["queued", "held"]),
      inArray(schema.staffNoticeDelivery.noticeId,
        tx.select({ id: schema.staffNotice.id }).from(schema.staffNotice).where(eq(schema.staffNotice.userId, userId))),
    ));
}

/* ------------------------------------------------------------ the worker */

/** Older than this, a notice that has not gone is history rather than news, as a technician's push is. */
export const STALE_HOURS = 12;
export const MAX_ATTEMPTS = 5;
export const RECEIPT_AFTER_MINUTES = 15;
export const CLAIM_MINUTES = 5;
/** How often each company's running out and unsigned talks are looked at, per worker. */
export const RAISE_EVERY_MS = 10 * 60_000;

const SEND_BATCH = 200;

/** What the worker acts as: it reads and writes notices, and nothing else of anybody's. */
function workerActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "staff-notices" };
}

export interface NoticeDeps {
  /** The push service; `false` sends no pushes on this pass. */
  push?: PushProvider | false | undefined;
  /** The carrier, in a test. Otherwise each company's own connected one. */
  sms?: MessagingProvider | undefined;
  now?: (() => Date) | undefined;
}

export interface NoticePassResult {
  organizationId: string;
  raised: number;
  pushed: number;
  texted: number;
  held: number;
  failed: number;
  skipped: number;
  error?: string;
}

const raisedAt = new Map<string, number>();

/**
 * One pass over every company with a notice to send, a receipt to ask for, or
 * a licence or a talk worth looking at. Each company's failure is its own.
 */
export async function noticePass(
  db: Database,
  options: NoticeDeps & { shouldStop?: () => boolean; only?: readonly string[] } = {},
): Promise<NoticePassResult[]> {
  const rows = within(options.only, await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.staff_notice_organizations(50)`,
  ));
  const results: NoticePassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const at = (options.now ?? (() => new Date()))().getTime();
    const raise = at - (raisedAt.get(row.organization_id) ?? 0) >= RAISE_EVERY_MS;
    try {
      results.push(await noticesFor(db, row.organization_id, { ...options, raise }));
      if (raise) raisedAt.set(row.organization_id, at);
    } catch (error) {
      results.push({
        organizationId: row.organization_id, raised: 0, pushed: 0, texted: 0, held: 0, failed: 0, skipped: 0,
        error: (error as Error).message,
      });
    }
  }
  return results;
}

/** Raise what is due, then send, for one company. */
export async function noticesFor(
  db: Database, organizationId: string, deps: NoticeDeps & { raise?: boolean } = {},
): Promise<NoticePassResult> {
  const now = deps.now ?? (() => new Date());
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  const result: NoticePassResult = { organizationId, raised: 0, pushed: 0, texted: 0, held: 0, failed: 0, skipped: 0 };
  if (deps.raise !== false) result.raised = await raiseDueFor(db, organizationId, now());
  if (deps.push !== false) {
    const provider = deps.push ?? new ExpoPushProvider();
    await sendPushes(ctx, provider, now(), result);
    await askReceipts(ctx, provider, now(), result);
  }
  await sendTexts(ctx, deps.sms, now(), result);
  return result;
}

/* ------------------------------------------------- what the worker raises */

/**
 * The two kinds nothing else raises: a licence or skill running out, and a
 * toolbox talk somebody has not signed. Each once per record per person, by
 * its key, so looking every ten minutes raises nothing new.
 *
 * WHO HEARS ABOUT A LICENCE. The person who holds it, on their own record,
 * and the person they answer to (the reporting line on `/tasks/escalation`),
 * on the holder's page, when that manager may read the holder's record. Not
 * every owner and office manager: the renewals list on `/certifications` is
 * theirs, and a notice to six people about one card is how notices become
 * something people switch off.
 */
export async function raiseDueFor(db: Database, organizationId: string, now: Date = new Date()): Promise<number> {
  const ctx: ServiceContext = { actor: workerActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    const zone = await timezoneOf(tx, organizationId);
    const today = time.dateIn(now, zone);
    const from = time.addDays(today, -rules.EXPIRY_LATE_DAYS);
    const to = time.addDays(today, rules.EXPIRY_NOTICE_DAYS);
    let raised = 0;

    const people = new Map((await tx.select({
      technicianId: schema.technician.id,
      name: schema.technician.displayName,
      userId: schema.membership.userId,
      reportsTo: schema.membership.reportsToUserId,
    }).from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(eq(schema.membership.active, true))).map((p) => [p.technicianId, p]));

    /**
     * The current holding of each certification only: a renewal is a new row
     * with a later date, and the old one running out is not news to anybody.
     */
    const certifications = await tx.select({
      id: schema.personCertification.id,
      technicianId: schema.personCertification.technicianId,
      expiresOn: schema.personCertification.expiresOn,
      name: schema.certificationType.name,
    }).from(schema.personCertification)
      .innerJoin(schema.certificationType, eq(schema.certificationType.id, schema.personCertification.certificationTypeId))
      .where(and(
        eq(schema.personCertification.status, "active"),
        gte(schema.personCertification.expiresOn, from),
        lte(schema.personCertification.expiresOn, to),
        sql`not exists (
          select 1 from public.person_certification later
           where later.technician_id = ${schema.personCertification.technicianId}
             and later.certification_type_id = ${schema.personCertification.certificationTypeId}
             and later.status = 'active'
             and (later.expires_on is null or later.expires_on > ${schema.personCertification.expiresOn})
        )`,
      ));

    const skills = await tx.select({
      id: schema.technicianSkill.id,
      technicianId: schema.technicianSkill.technicianId,
      expiresOn: schema.technicianSkill.expiresOn,
      name: schema.technicianSkill.skill,
    }).from(schema.technicianSkill)
      .where(and(
        isNull(schema.technicianSkill.endedOn),
        gte(schema.technicianSkill.expiresOn, from),
        lte(schema.technicianSkill.expiresOn, to),
      ));

    const records = [
      ...certifications.map((c) => ({ ...c, type: "person_certification" as const })),
      ...skills.map((s) => ({ ...s, type: "technician_skill" as const, name: `skill ${s.name}` })),
    ];
    for (const record of records) {
      if (!record.expiresOn) continue;
      const due = rules.expiryNoticeDue(record.expiresOn, today);
      if (!due) continue;
      const holder = people.get(record.technicianId);
      if (!holder) continue;
      const when = due === "soon" ? "runs out soon" : "runs out today";
      const key = `${record.type}:${record.id}:${due}`;
      const about: About = { type: record.type, id: record.id };

      const own = await raiseWithin(tx, {
        organizationId, userId: holder.userId, kind: "qualification_expiry", key, about,
        title: `Your ${record.name} ${when}`,
        body: `${rules.expirySentence(`Your ${record.name}`, record.expiresOn, today)} `
          + "Renew it and show the office, so you can keep being sent to the work that needs it.",
      });
      if (own.told) raised += 1;

      if (holder.reportsTo && holder.reportsTo !== holder.userId) {
        const manager = await raiseWithin(tx, {
          organizationId, userId: holder.reportsTo, kind: "qualification_expiry", key, about,
          title: `${holder.name}'s ${record.name} ${when}`,
          body: rules.expirySentence(`${holder.name}'s ${record.name}`, record.expiresOn, today),
        });
        if (manager.told) raised += 1;
      }
    }

    /** A talk held, an hour gone, a line on it nobody signed, with somebody of ours behind it. */
    const lines = await tx.select({
      attendeeId: schema.safetyMeetingAttendee.id,
      technicianId: schema.safetyMeetingAttendee.technicianId,
      meetingId: schema.safetyMeeting.id,
      topic: schema.safetyMeeting.topic,
      heldAt: schema.safetyMeeting.heldAt,
    }).from(schema.safetyMeetingAttendee)
      .innerJoin(schema.safetyMeeting, eq(schema.safetyMeeting.id, schema.safetyMeetingAttendee.meetingId))
      .where(and(
        isNull(schema.safetyMeeting.closedAt),
        isNull(schema.safetyMeetingAttendee.signedAt),
        isNotNull(schema.safetyMeetingAttendee.technicianId),
        gte(schema.safetyMeeting.heldAt, new Date(now.getTime() - rules.TALK_NUDGE_WITHIN_DAYS * 86_400_000)),
        lte(schema.safetyMeeting.heldAt, new Date(now.getTime() - rules.TALK_NUDGE_AFTER_MINUTES * 60_000)),
      ))
      .orderBy(asc(schema.safetyMeeting.heldAt))
      .limit(500);
    for (const line of lines) {
      if (!rules.talkNudgeDue(line.heldAt, now)) continue;
      const person = line.technicianId ? people.get(line.technicianId) : undefined;
      if (!person) continue;
      const outcome = await raiseWithin(tx, {
        organizationId, userId: person.userId, kind: "talk_unsigned", key: `talk:${line.attendeeId}`,
        about: { type: "safety_meeting", id: line.meetingId },
        title: `Sign the toolbox talk: ${line.topic}`,
        body: `The talk held ${time.dateIn(line.heldAt, zone)} is waiting for your signature. Sign it on My day.`,
      });
      if (outcome.told) raised += 1;
    }
    return raised;
  });
}

/* ------------------------------------------------------------------ push */

/**
 * What rides with a notice to the phone, so a tap opens what it is about.
 *
 * The notice's id (the phone marks it read), its kind, the kind and id of the
 * record, and the page the bell would open. Nothing the bell does not show: the
 * words are the title and body, which the lock screen shows too, and a record
 * is only an opaque id. The phone opens a visit or a task it holds from the
 * kind and id, and anything else in the browser from `href`.
 */
export function pushData(row: { noticeId: string; kind: string; href: string; entityType: string; entityId: string }) {
  return {
    noticeId: row.noticeId, kind: row.kind, href: row.href,
    about: { type: row.entityType, id: row.entityId },
  };
}

async function sendPushes(ctx: ServiceContext, provider: PushProvider, now: Date, result: NoticePassResult) {
  const staleBefore = new Date(now.getTime() - STALE_HOURS * 3_600_000);
  const due = await inTenant(ctx, async (tx) => {
    /** A claim a worker never finished goes back; a second buzz is the smaller harm, as for a technician's. */
    await tx.update(schema.staffNoticeDelivery).set({ status: "queued", updatedAt: now })
      .where(and(
        eq(schema.staffNoticeDelivery.channel, "push"),
        eq(schema.staffNoticeDelivery.status, "sending"),
        lt(schema.staffNoticeDelivery.updatedAt, new Date(now.getTime() - CLAIM_MINUTES * 60_000)),
      ));
    const claimed = await claim(tx, "push", now);
    if (claimed.length === 0) return [];

    const rows = await tx.select({
      id: schema.staffNoticeDelivery.id,
      deviceId: schema.staffNoticeDelivery.deviceId,
      attempts: schema.staffNoticeDelivery.attempts,
      createdAt: schema.staffNoticeDelivery.createdAt,
      noticeId: schema.staffNotice.id,
      kind: schema.staffNotice.kind,
      title: schema.staffNotice.title,
      body: schema.staffNotice.body,
      href: schema.staffNotice.href,
      entityType: schema.staffNotice.entityType,
      entityId: schema.staffNotice.entityId,
      token: schema.device.pushToken,
      revokedAt: schema.device.revokedAt,
    }).from(schema.staffNoticeDelivery)
      .innerJoin(schema.staffNotice, eq(schema.staffNotice.id, schema.staffNoticeDelivery.noticeId))
      .innerJoin(schema.device, eq(schema.device.id, schema.staffNoticeDelivery.deviceId))
      .where(inArray(schema.staffNoticeDelivery.id, claimed))
      .orderBy(asc(schema.staffNoticeDelivery.createdAt));

    const gone = rows.filter((r) => !r.token || r.revokedAt);
    const stale = rows.filter((r) => r.token && !r.revokedAt && r.createdAt < staleBefore);
    await skip(tx, gone.map((r) => r.id), "The phone was signed out or taken away before it could be told.");
    await skip(tx, stale.map((r) => r.id), `Not sent within ${STALE_HOURS} hours, so it was no longer news.`);
    result.skipped += gone.length + stale.length;

    const quiet = await quietHoursFor(tx, ctx.actor.organizationId, now);
    const silent = field.pushUrgency({
      localMinutes: time.minutesInDay(now, quiet.zone), now, window: quiet.window, visitStartsAt: null,
    }) === "quiet";
    const live = rows.filter((r) => r.token && !r.revokedAt && r.createdAt >= staleBefore);
    if (silent && live.length > 0) {
      await tx.update(schema.staffNoticeDelivery).set({ quiet: true })
        .where(inArray(schema.staffNoticeDelivery.id, live.map((r) => r.id)));
    }
    return live.map((r) => ({ ...r, quiet: silent }));
  });
  if (due.length === 0) return;

  let tickets: PushTicket[];
  try {
    tickets = await provider.send(due.map((row) => ({
      to: row.token!,
      title: row.title,
      body: row.body ?? "",
      data: pushData(row),
      quiet: row.quiet,
    })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tickets = due.map(() => ({ ok: false as const, error: message, gone: false, retryable: true }));
  }

  await inTenant(ctx, async (tx) => {
    for (const [i, row] of due.entries()) {
      const ticket = tickets[i] ?? { ok: false as const, error: "No answer for this notice.", gone: false, retryable: true };
      if (ticket.ok) {
        await tx.update(schema.staffNoticeDelivery).set({
          status: "sent", ticketId: ticket.id, sentAt: now, attempts: row.attempts + 1, error: null, updatedAt: now,
        }).where(eq(schema.staffNoticeDelivery.id, row.id));
        result.pushed += 1;
        continue;
      }
      const attempts = row.attempts + 1;
      const giveUp = !ticket.retryable || attempts >= MAX_ATTEMPTS;
      await tx.update(schema.staffNoticeDelivery).set({
        status: giveUp ? "failed" : "queued", attempts, error: ticket.error.slice(0, 500), updatedAt: now,
      }).where(eq(schema.staffNoticeDelivery.id, row.id));
      if (giveUp) result.failed += 1;
      if (ticket.gone && row.deviceId) await forgetToken(tx, ctx, row.deviceId, ticket.error);
    }
  });
}

async function askReceipts(ctx: ServiceContext, provider: PushProvider, now: Date, result: NoticePassResult) {
  const owed = await inTenant(ctx, async (tx) => tx.select({
    id: schema.staffNoticeDelivery.id,
    deviceId: schema.staffNoticeDelivery.deviceId,
    ticketId: schema.staffNoticeDelivery.ticketId,
  }).from(schema.staffNoticeDelivery)
    .where(and(
      eq(schema.staffNoticeDelivery.channel, "push"),
      eq(schema.staffNoticeDelivery.status, "sent"),
      isNotNull(schema.staffNoticeDelivery.ticketId),
      isNull(schema.staffNoticeDelivery.receiptCheckedAt),
      lt(schema.staffNoticeDelivery.sentAt, new Date(now.getTime() - RECEIPT_AFTER_MINUTES * 60_000)),
    ))
    .limit(1000));
  if (owed.length === 0) return;

  let receipts: Awaited<ReturnType<PushProvider["receipts"]>>;
  try {
    receipts = await provider.receipts(owed.map((row) => row.ticketId!));
  } catch {
    return;
  }
  await inTenant(ctx, async (tx) => {
    for (const row of owed) {
      const receipt = receipts[row.ticketId!];
      if (receipt && !receipt.ok) {
        await tx.update(schema.staffNoticeDelivery).set({
          status: "failed", error: receipt.error.slice(0, 500), receiptCheckedAt: now, updatedAt: now,
        }).where(eq(schema.staffNoticeDelivery.id, row.id));
        result.failed += 1;
        if (receipt.gone && row.deviceId) await forgetToken(tx, ctx, row.deviceId, receipt.error);
        continue;
      }
      await tx.update(schema.staffNoticeDelivery).set({ receiptCheckedAt: now, updatedAt: now })
        .where(eq(schema.staffNoticeDelivery.id, row.id));
    }
  });
}

/* ----------------------------------------------------------------- texts */

/**
 * Texts to staff, straight to the company's carrier from its own registered
 * number, and NOT through the outbox. The outbox keeps every text in the
 * company's inbox, where the whole office reads it, and a notice names records
 * only its person may open; a text there would tell everybody else.
 *
 * Asked at the moment it goes, through core's `textDecision`: the person's own
 * consent, a STOP from that number, a number to send from, and the company's
 * quiet hours, which hold a text until morning rather than lose it.
 *
 * NEVER TWICE. A text claimed and never marked, because the worker died
 * handing it over, is not sent again: whether it went is unknown, and a second
 * text about the same thing is worse than the row saying so.
 */
async function sendTexts(ctx: ServiceContext, injected: MessagingProvider | undefined, now: Date, result: NoticePassResult) {
  const organizationId = ctx.actor.organizationId;
  const staleBefore = new Date(now.getTime() - STALE_HOURS * 3_600_000);

  const plan = await inTenant(ctx, async (tx) => {
    await tx.update(schema.staffNoticeDelivery).set({
      status: "failed", updatedAt: now,
      error: "The worker stopped while handing this to the carrier, so whether it went is not known. It is not sent again, so nobody gets it twice.",
    }).where(and(
      eq(schema.staffNoticeDelivery.channel, "sms"),
      eq(schema.staffNoticeDelivery.status, "sending"),
      lt(schema.staffNoticeDelivery.updatedAt, new Date(now.getTime() - CLAIM_MINUTES * 60_000)),
    ));
    /** The morning has come for what was held overnight. */
    await tx.update(schema.staffNoticeDelivery).set({ status: "queued", holdUntil: null, updatedAt: now })
      .where(and(
        eq(schema.staffNoticeDelivery.channel, "sms"),
        eq(schema.staffNoticeDelivery.status, "held"),
        lte(schema.staffNoticeDelivery.holdUntil, now),
      ));
    const claimed = await claim(tx, "sms", now);
    if (claimed.length === 0) return null;

    const rows = await tx.select({
      id: schema.staffNoticeDelivery.id,
      address: schema.staffNoticeDelivery.address,
      attempts: schema.staffNoticeDelivery.attempts,
      createdAt: schema.staffNoticeDelivery.createdAt,
      userId: schema.staffNotice.userId,
      title: schema.staffNotice.title,
      body: schema.staffNotice.body,
      href: schema.staffNotice.href,
    }).from(schema.staffNoticeDelivery)
      .innerJoin(schema.staffNotice, eq(schema.staffNotice.id, schema.staffNoticeDelivery.noticeId))
      .where(inArray(schema.staffNoticeDelivery.id, claimed))
      .orderBy(asc(schema.staffNoticeDelivery.createdAt));

    const from = await senderFor(tx, organizationId, { smsRequired: true });
    const quiet = await quietHoursFor(tx, organizationId, now);
    const localMinutes = time.minutesInDay(now, quiet.zone);
    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, organizationId)).limit(1);
    const base = publicBaseUrl();
    const sendable: { id: string; to: string; body: string; attempts: number }[] = [];

    for (const row of rows) {
      const address = row.address ?? "";
      if (row.createdAt < staleBefore) {
        await skip(tx, [row.id], `Not sent within ${STALE_HOURS} hours, so it was no longer news.`);
        result.skipped += 1;
        continue;
      }
      const consent = await consentWithin(tx, row.userId);
      const suppressions = await tx.select().from(schema.suppression)
        .where(and(eq(schema.suppression.address, address), isNull(schema.suppression.liftedAt)));
      const decision = rules.textDecision({
        consent: consent ? { state: consent.state, address: consent.address } : null,
        address,
        suppressions: suppressions.map((s) => ({
          channel: s.channel as comms.Channel, purpose: s.purpose as comms.Purpose | null, liftedAt: s.liftedAt,
        })),
        channelRegistered: Boolean(from?.smsRegistered),
        quietHours: quiet.window,
        localMinutes,
        now,
      });
      if (decision.action === "refuse") {
        await skip(tx, [row.id], rules.textRefusalWords(decision.reason));
        result.skipped += 1;
        continue;
      }
      if (decision.action === "hold") {
        await tx.update(schema.staffNoticeDelivery).set({ status: "held", holdUntil: decision.until, updatedAt: now })
          .where(eq(schema.staffNoticeDelivery.id, row.id));
        result.held += 1;
        continue;
      }
      const lines = [`${org?.name ?? "Work"}: ${row.title}`, row.body ?? "", base ? `${base}${row.href}` : ""]
        .filter((line) => line !== "");
      sendable.push({ id: row.id, to: address, body: lines.join("\n").slice(0, 600), attempts: row.attempts });
    }
    if (sendable.length === 0) return null;

    let provider: MessagingProvider | null = injected ?? null;
    if (!provider) {
      provider = await smsProviderFor(tx, organizationId, readerFor(tx, organizationId)).catch(() => null);
    }
    if (!provider || !from) {
      await skip(tx, sendable.map((s) => s.id), "The company has no text messaging connected.");
      result.skipped += sendable.length;
      return null;
    }
    return { provider, from: from.e164, sendable };
  });
  if (!plan) return;

  for (const text of plan.sendable) {
    const sent = await plan.provider.send({ to: text.to, from: plan.from, body: text.body, reference: text.id })
      .catch((error: unknown) => ({
        ok: false as const, code: "error", message: error instanceof Error ? error.message : String(error), retryable: true,
      }));
    await inTenant(ctx, async (tx) => {
      if (sent.ok) {
        await tx.update(schema.staffNoticeDelivery).set({
          status: "sent", providerMessageId: sent.providerMessageId, sentAt: now, attempts: text.attempts + 1,
          error: null, updatedAt: now,
        }).where(eq(schema.staffNoticeDelivery.id, text.id));
        result.texted += 1;
        return;
      }
      const attempts = text.attempts + 1;
      const giveUp = !sent.retryable || attempts >= MAX_ATTEMPTS;
      await tx.update(schema.staffNoticeDelivery).set({
        status: giveUp ? "failed" : "queued", attempts, error: sent.message.slice(0, 500), updatedAt: now,
      }).where(eq(schema.staffNoticeDelivery.id, text.id));
      if (giveUp) result.failed += 1;
    });
  }
}

/**
 * Claimed in one statement, so two workers running at once take different
 * rows: `skip locked` passes over a row another worker's claim is holding.
 */
async function claim(tx: Database, channel: "push" | "sms", now: Date): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    update public.staff_notice_delivery set status = 'sending', updated_at = ${now.toISOString()}::timestamptz
     where id in (
       select id from public.staff_notice_delivery
        where status = 'queued' and channel = ${channel}::staff_delivery_channel
        order by created_at
        limit ${SEND_BATCH}
        for update skip locked
     )
    returning id
  `);
  return rows.map((row) => row.id);
}

async function skip(tx: Database, ids: string[], reason: string): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(schema.staffNoticeDelivery).set({ status: "skipped", error: reason, updatedAt: new Date() })
    .where(inArray(schema.staffNoticeDelivery.id, ids));
}

/* --------------------------------------------------------------- the API */

export const handlers = {
  listMyNotices: (ctx: ServiceContext, input: { limit?: number | undefined; unread?: boolean | undefined }) =>
    list(ctx, input),
  readMyNotices: (ctx: ServiceContext, input: { ids?: string[] | undefined; all?: boolean | undefined }) =>
    markRead(ctx, input),
  getMyNoticeSettings: (ctx: ServiceContext) => settings(ctx),
  setMyNoticeSettings: (ctx: ServiceContext, input: { kinds: ({ kind: string } & rules.NoticeSwitches)[] }) =>
    setSwitches(ctx, input),
  setMyNoticeTexts: (ctx: ServiceContext, input: { on: boolean; mobilePhone?: string | null | undefined; agreed?: boolean | undefined }) =>
    setTexts(ctx, input),
} as const;
