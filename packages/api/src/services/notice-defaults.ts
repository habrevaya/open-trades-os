import { eq } from "drizzle-orm";
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
 * a person's own choice on `/me` is never replaced. Nothing here is applied
 * back onto existing people, deliberately: a person who turned a kind off
 * must not find it back on because the office changed its mind.
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

const brief = (k: NoticeDefaultsView["kinds"][number]) => ({ kind: k.kind, inApp: k.inApp, push: k.push, email: k.email });

export const handlers = {
  getNoticeDefaults: (ctx: ServiceContext) => defaults(ctx),
  setNoticeDefaults: (
    ctx: ServiceContext,
    input: { kinds: { kind: string; inApp: boolean; push: boolean; email?: boolean | undefined }[] },
  ) => setDefaults(ctx, input),
} as const;

