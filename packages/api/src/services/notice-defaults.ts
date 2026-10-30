import { and, asc, eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { notices as rules } from "@opentradesos/core";
import { audit, guardedRead, guardedWrite, ConflictError, type ServiceContext } from "./context";

/**
 * WHAT A NEW PERSON'S NOTICES START AS, AS THE COMPANY SETS IT (M34)
 *
 * Until now every person started on the same switches for every kind of
 * notice: in the app and on the phone, never a text. A company can now change
 * that per kind, on Settings, for the people it adds from then on.
 *
 * SEEDS, NEVER OVERRULES. What is set here is copied onto a person's own
 * switches when their membership is made (the `membership_notice_defaults`
 * trigger, so the setup wizard, an invite and an import all do it the same
 * way). After that the person's own row is the only thing read. So editing
 * these changes nobody who is already here, however long ago they joined, and
 * a person's own choice on `/me` is never replaced. Saving these applies them
 * back onto nobody, deliberately: a person who turned a kind off must not find
 * it back on because the office changed its mind.
 *
 * APPLYING THEM TO EVERYBODY is a separate act the company asks for, after
 * being shown what it will change (`applyPreview`, then `applyToEverybody`
 * with `confirmed`). It still never replaces a person's own choice: a kind
 * they set on `/me` is theirs (`staff_notice_setting.chosen`). Only a kind
 * they never chose takes the company's defaults: one the defaults copied onto
 * them when they joined, or one with no row at all. Texts are never touched.
 *
 * NO TEXT SWITCH. A text goes to somebody's own mobile on their own bill, and
 * only ever because they turned it on with their own number and their own say
 * so. A company cannot start anybody with it.
 */

export interface NoticeDefaultsView {
  kinds: ({ kind: rules.NoticeKind; label: string; description: string } & rules.NoticeDefault)[];
}

async function viewWithin(tx: Database, organizationId: string): Promise<NoticeDefaultsView> {
  const saved = await tx.select().from(schema.staffNoticeDefault)
    .where(eq(schema.staffNoticeDefault.organizationId, organizationId));
  return {
    kinds: rules.NOTICE_KINDS.map((kind) => ({
      kind, ...rules.NOTICE_KIND_WORDS[kind], ...rules.defaultsFor(saved, kind),
    })),
  };
}

/** What a new person starts on, per kind. `settings:read`. */
export function defaults(ctx: ServiceContext): Promise<NoticeDefaultsView> {
  return guardedRead(ctx, "settings:read", (tx) => viewWithin(tx, ctx.actor.organizationId));
}

/**
 * Change what new people start on. `settings:write`, audited. Only the kinds
 * sent change. Nobody already in the company is touched.
 */
export function setDefaults(
  ctx: ServiceContext,
  input: { kinds: { kind: string; inApp: boolean; push: boolean; email?: boolean | undefined }[] },
): Promise<NoticeDefaultsView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const problem = rules.defaultsProblem(input.kinds);
    if (problem) throw new ConflictError(problem);
    const before = await viewWithin(tx, ctx.actor.organizationId);
    for (const k of input.kinds) {
      const kind = k.kind as rules.NoticeKind;
      /** Only a kind that is emailed keeps a choice; the others never read it. */
      const email = rules.isEmailKind(kind) ? k.email ?? rules.defaultsFor([], kind).email : null;
      await tx.insert(schema.staffNoticeDefault).values({
        organizationId: ctx.actor.organizationId, kind, inApp: k.inApp, push: k.push, email,
      }).onConflictDoUpdate({
        target: [schema.staffNoticeDefault.organizationId, schema.staffNoticeDefault.kind],
        set: { inApp: k.inApp, push: k.push, email, deletedAt: null, updatedAt: new Date() },
      });
    }
    const after = await viewWithin(tx, ctx.actor.organizationId);
    await audit(tx, ctx, "staff_notice_defaults.changed", "organization", ctx.actor.organizationId,
      { kinds: before.kinds.map(brief) }, { kinds: after.kinds.map(brief) });
    return after;
  });
}

/* ------------------------------------------- applying them to everybody */

export interface ApplyOutcome {
  /** People who work here now. */
  people: number;
  /** People at least one of whose kinds changes (or changed). */
  changed: number;
  /** Kinds changed across everybody. */
  kinds: number;
  /** People who keep at least one kind they chose themselves. */
  keptOwn: number;
}

/**
 * What applying the company's defaults to everybody would do, or does, inside
 * a transaction. `write` false only counts.
 */
async function applyWithin(tx: Database, organizationId: string, write: boolean): Promise<ApplyOutcome> {
  const saved = await tx.select().from(schema.staffNoticeDefault)
    .where(eq(schema.staffNoticeDefault.organizationId, organizationId));
  const members = await tx.select({ userId: schema.membership.userId }).from(schema.membership)
    .where(and(eq(schema.membership.organizationId, organizationId), eq(schema.membership.active, true)))
    .orderBy(asc(schema.membership.createdAt));
  const rows = await tx.select().from(schema.staffNoticeSetting)
    .where(eq(schema.staffNoticeSetting.organizationId, organizationId));
  const outcome: ApplyOutcome = { people: members.length, changed: 0, kinds: 0, keptOwn: 0 };
  for (const member of members) {
    let changed = false;
    let kept = false;
    for (const kind of rules.NOTICE_KINDS) {
      const row = rows.find((r) => r.userId === member.userId && r.kind === kind) ?? null;
      const decided = rules.appliedDefault(row, rules.defaultsFor(saved, kind), kind);
      if (decided === "kept") { kept = true; continue; }
      if (decided === null) continue;
      changed = true;
      outcome.kinds += 1;
      if (!write) continue;
      if (row) {
        await tx.update(schema.staffNoticeSetting)
          .set({ inApp: decided.inApp, push: decided.push, email: decided.email, updatedAt: new Date() })
          .where(and(eq(schema.staffNoticeSetting.id, row.id), eq(schema.staffNoticeSetting.chosen, false)));
      } else {
        await tx.insert(schema.staffNoticeSetting).values({
          organizationId, userId: member.userId, kind,
          inApp: decided.inApp, push: decided.push, text: false, email: decided.email, chosen: false,
        }).onConflictDoNothing();
      }
    }
    if (changed) outcome.changed += 1;
    if (kept) outcome.keptOwn += 1;
  }
  return outcome;
}

/** What applying the defaults to everybody would change, for the question asked first. `settings:read`. */
export function applyPreview(ctx: ServiceContext): Promise<ApplyOutcome> {
  return guardedRead(ctx, "settings:read", (tx) => applyWithin(tx, ctx.actor.organizationId, false));
}

/**
 * Give everybody who works here the company's defaults, for every kind they
 * never chose themselves. `settings:write`, audited, and only with `confirmed`
 * true: the screen asks first, and so does the API. A kind a person set on
 * `/me` is kept, and texts are never touched. Running it again changes nothing
 * more, so a retry is safe.
 */
export function applyToEverybody(ctx: ServiceContext, input: { confirmed: boolean }): Promise<ApplyOutcome> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    if (input.confirmed !== true) {
      throw new ConflictError("Say yes to giving everybody the company's defaults first. A choice a person made themselves is kept.");
    }
    const outcome = await applyWithin(tx, ctx.actor.organizationId, true);
    await audit(tx, ctx, "staff_notice_defaults.applied", "organization", ctx.actor.organizationId, null, { ...outcome });
    return outcome;
  });
}

const brief = (k: NoticeDefaultsView["kinds"][number]) => ({ kind: k.kind, inApp: k.inApp, push: k.push, email: k.email });

export const handlers = {
  getNoticeDefaults: (ctx: ServiceContext) => defaults(ctx),
  setNoticeDefaults: (
    ctx: ServiceContext,
    input: { kinds: { kind: string; inApp: boolean; push: boolean; email?: boolean | undefined }[] },
  ) => setDefaults(ctx, input),
  previewNoticeDefaultsApplied: (ctx: ServiceContext) => applyPreview(ctx),
  applyNoticeDefaults: (ctx: ServiceContext, input: { confirmed: boolean }) => applyToEverybody(ctx, input),
} as const;

