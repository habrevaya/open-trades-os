import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, referrals as rf, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, InvalidGrantError, NotFoundError,
  type ServiceContext,
} from "./context";
import * as marketing from "./marketing";
import * as creditNotes from "./credit-notes";
import { inGrant, peek } from "./portal";
import { portalBase } from "../lib/portal-base";

/**
 * REFERRALS, FROM THE LINK TO THE REWARD
 *
 * A customer's code is minted the first time anybody asks for it, on their
 * account page or in the office. Their link is the company's booking page with
 * `ref` on it; the website snippet carries `ref` from any page of the
 * company's own site too. Every path that records a touch reads the code
 * (`marketing.recordTouch`), so a visit through a referral link is a touch
 * credited to `referral_customer` naming the referrer, and the moment that
 * visitor becomes a customer they learn who sent them
 * (`marketing.claimReferral`).
 *
 * The reward is granted by the worker when the referred customer's first job
 * is paid in full: a credit note on the referrer's account, or an amount
 * recorded as owed, as the company's settings say, once per referred customer
 * however many times the worker looks.
 */

/* ------------------------------------------------------------- settings */

export async function settingsWithin(tx: Database, organizationId: string): Promise<rf.ReferralSettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const stored = ((row?.settings ?? {}) as Record<string, unknown>)["referrals"] as Record<string, unknown> | undefined;
  const checked = rf.checkReferralSettings(stored ?? {});
  return checked.ok ? checked.settings : rf.DEFAULT_REFERRAL_SETTINGS;
}

export async function setSettings(ctx: ServiceContext, input: { reward: string; amount?: string | undefined }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const checked = rf.checkReferralSettings(input);
    if (!checked.ok) throw new ConflictError(checked.reason);
    const before = await settingsWithin(tx, ctx.actor.organizationId);
    await tx.update(schema.organization).set({
      settings: sql`${schema.organization.settings} || ${JSON.stringify({ referrals: checked.settings })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "referrals.settings", "organization", ctx.actor.organizationId, before, checked.settings);
    return checked.settings;
  });
}

/* ---------------------------------------------------------------- codes */

/**
 * This customer's code, minted if they have none.
 *
 * The one write a read path makes, and a harmless one: idempotent, and
 * invisible until somebody shares the link. A collision with another
 * customer's code is retried with a fresh one; the unique index is what
 * decides, not a lookup first.
 */
export async function codeFor(tx: Database, organizationId: string, customerId: string): Promise<string> {
  const [row] = await tx.select({ code: schema.customer.referralCode }).from(schema.customer)
    .where(and(eq(schema.customer.id, customerId), eq(schema.customer.organizationId, organizationId))).limit(1);
  if (!row) throw new NotFoundError("Customer");
  if (row.code) return row.code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = rf.newReferralCode(() => randomInt(0, 1_000_000) / 1_000_000);
    const [taken] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.organizationId, organizationId), eq(schema.customer.referralCode, code))).limit(1);
    if (taken) continue;
    const [set] = await tx.update(schema.customer).set({ referralCode: code })
      .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.referralCode)))
      .returning({ code: schema.customer.referralCode });
    if (set?.code) return set.code;
    const [now] = await tx.select({ code: schema.customer.referralCode }).from(schema.customer)
      .where(eq(schema.customer.id, customerId)).limit(1);
    if (now?.code) return now.code;
  }
  throw new ConflictError("Could not mint a referral code. Try again.");
}

async function slugOf(tx: Database, organizationId: string): Promise<string> {
  const [org] = await tx.select({ slug: schema.organization.slug }).from(schema.organization)
    .where(eq(schema.organization.id, organizationId)).limit(1);
  return org?.slug ?? "";
}

export interface CustomerReferral {
  code: string;
  link: string;
  referredBy: { id: string; name: string } | null;
  referred: { id: string; name: string; reward: { state: string; amount: string } | null }[];
}

async function referralWithin(tx: Database, organizationId: string, customerId: string): Promise<CustomerReferral> {
  const code = await codeFor(tx, organizationId, customerId);
  const [self] = await tx.select({ referredBy: schema.customer.referredByCustomerId }).from(schema.customer)
    .where(eq(schema.customer.id, customerId)).limit(1);
  const [referrer] = self?.referredBy
    ? await tx.select({ id: schema.customer.id, name: schema.customer.name }).from(schema.customer)
      .where(eq(schema.customer.id, self.referredBy)).limit(1)
    : [];
  const referred = await tx.select({
    id: schema.customer.id, name: schema.customer.name,
    state: schema.referralReward.state, amount: schema.referralReward.amount,
  }).from(schema.customer)
    .leftJoin(schema.referralReward, eq(schema.referralReward.referredCustomerId, schema.customer.id))
    .where(and(eq(schema.customer.referredByCustomerId, customerId), isNull(schema.customer.deletedAt)))
    .orderBy(asc(schema.customer.createdAt));
  return {
    code,
    link: rf.referralLink(portalBase(), await slugOf(tx, organizationId), code),
    referredBy: referrer ?? null,
    referred: referred.map((r) => ({
      id: r.id, name: r.name, reward: r.state ? { state: r.state, amount: r.amount ?? "0" } : null,
    })),
  };
}

/** The office's view of one customer's referrals. */
export async function forCustomer(ctx: ServiceContext, customerId: string): Promise<CustomerReferral> {
  return guardedRead(ctx, "customer:read", (tx) => referralWithin(tx, ctx.actor.organizationId, customerId));
}

/**
 * The customer's own view, from their account link.
 *
 * Their code and link, and the first name of everybody they referred, which
 * is what "thank you, the Nguyens booked" needs and no more: no amounts owed
 * to anybody else, nobody else's surname.
 */
export async function forPortal(db: Database, input: { token: string }) {
  const grant = await peek(db, input.token);
  if (grant.scope !== "customer" || !grant.customerId) throw new InvalidGrantError();
  const customerId = grant.customerId;
  return inGrant(db, grant, async (tx) => {
    const mine = await referralWithin(tx, grant.organizationId, customerId);
    const settings = await settingsWithin(tx, grant.organizationId);
    return {
      code: mine.code,
      link: mine.link,
      reward: settings.reward === "none" ? null : { kind: settings.reward, amount: settings.amount },
      referred: mine.referred.map((r) => ({
        firstName: r.name.split(" ")[0] ?? r.name,
        rewarded: r.reward !== null && r.reward.state !== "void",
      })),
    };
  });
}

/**
 * Who referred this customer, set by the office.
 *
 * For the referral that arrived as "Mrs Alvarez told us about you" on the
 * phone. Written as a declared touch naming the referrer as well, so the
 * attribution reports hear about it the way they hear about a link, and the
 * customer column is set only when it is empty: the office can correct an
 * empty answer, and changing an existing one is a deliberate second call
 * with `replace`.
 */
export async function setReferredBy(
  ctx: ServiceContext,
  input: { customerId: string; referrerId: string | null; replace?: boolean | undefined },
) {
  return guardedWrite(ctx, "customer:write", async (tx) => {
    const org = ctx.actor.organizationId;
    if (input.referrerId === input.customerId) throw new ConflictError("A customer cannot refer themselves.");
    const [customer] = await tx.select().from(schema.customer)
      .where(and(eq(schema.customer.id, input.customerId), isNull(schema.customer.deletedAt))).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    if (customer.referredByCustomerId && !input.replace && input.referrerId !== null) {
      throw new ConflictError("This customer already has a referrer. Replace it deliberately if it is wrong.");
    }
    const [rewarded] = await tx.select({ id: schema.referralReward.id }).from(schema.referralReward)
      .where(and(eq(schema.referralReward.referredCustomerId, input.customerId), ne(schema.referralReward.state, "void")))
      .limit(1);
    if (rewarded && customer.referredByCustomerId !== input.referrerId) {
      throw new ConflictError("A reward has already been given for this referral. Void it before changing who referred them.");
    }
    if (input.referrerId) {
      const [referrer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
        .where(and(eq(schema.customer.id, input.referrerId), isNull(schema.customer.deletedAt))).limit(1);
      if (!referrer) throw new NotFoundError("Referring customer");
      const touch = await marketing.recordDeclaredTouch(tx, org, {
        source: "referral_customer", customerId: input.customerId, enteredByUserId: ctx.actor.userId,
      });
      await tx.update(schema.marketingTouch).set({ referrerCustomerId: input.referrerId })
        .where(eq(schema.marketingTouch.id, touch.id));
    }
    await tx.update(schema.customer).set({ referredByCustomerId: input.referrerId, updatedAt: new Date() })
      .where(eq(schema.customer.id, input.customerId));
    await audit(tx, ctx, "customer.referred_by", "customer", input.customerId,
      { referredBy: customer.referredByCustomerId }, { referredBy: input.referrerId });
    return { customerId: input.customerId, referredByCustomerId: input.referrerId };
  });
}

/* ------------------------------------------------------------ the screen */

/** Every referrer, everybody they sent, and every reward, for `Marketing > Referrals`. */
export async function overview(ctx: ServiceContext) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    /**
     * Written out with explicit table names: drizzle renders an interpolated
     * column bare, and inside this subquery a bare `referred_by_customer_id`
     * would resolve against c2 and name nobody (see `phone-numbers.ts`).
     */
    const referrer = sql<string>`(select c2.name from customer c2 where c2.id = "customer"."referred_by_customer_id")`;
    const referred = await tx.select({
      id: schema.customer.id,
      name: schema.customer.name,
      referrerId: schema.customer.referredByCustomerId,
      referrerName: referrer,
      since: schema.customer.createdAt,
    }).from(schema.customer)
      .where(and(isNotNull(schema.customer.referredByCustomerId), isNull(schema.customer.deletedAt)))
      .orderBy(desc(schema.customer.createdAt)).limit(500);
    const rewards = await tx.select().from(schema.referralReward)
      .orderBy(desc(schema.referralReward.createdAt)).limit(500);
    const rewardBy = new Map(rewards.map((r) => [r.referredCustomerId, r]));

    const referrers = new Map<string, { id: string; name: string; referred: number; rewarded: number }>();
    for (const row of referred) {
      if (!row.referrerId) continue;
      const entry = referrers.get(row.referrerId)
        ?? { id: row.referrerId, name: row.referrerName ?? "", referred: 0, rewarded: 0 };
      entry.referred += 1;
      const reward = rewardBy.get(row.id);
      if (reward && reward.state !== "void") entry.rewarded += 1;
      referrers.set(row.referrerId, entry);
    }
    return {
      settings: await settingsWithin(tx, ctx.actor.organizationId),
      referrers: [...referrers.values()].sort((a, b) => b.referred - a.referred),
      referred: referred.map((r) => {
        const reward = rewardBy.get(r.id);
        return {
          id: r.id, name: r.name, referrerId: r.referrerId, referrerName: r.referrerName,
          since: r.since.toISOString(),
          reward: reward ? {
            id: reward.id, kind: reward.kind, amount: reward.amount, state: reward.state,
            creditNoteId: reward.creditNoteId, paidAt: reward.paidAt?.toISOString() ?? null,
          } : null,
        };
      }),
    };
  });
}

/**
 * An owed reward, paid; or any reward, withdrawn.
 *
 * `invoice:credit`, because both are the company giving money to a
 * customer, which is what that permission already decides. A credit note
 * reward is voided through the credit note itself; this only marks it.
 */
export async function settleReward(
  ctx: ServiceContext, input: { id: string; action: "paid" | "void"; note?: string | undefined },
) {
  return guardedWrite(ctx, "invoice:credit", async (tx) => {
    const [reward] = await tx.select().from(schema.referralReward)
      .where(eq(schema.referralReward.id, input.id)).limit(1);
    if (!reward) throw new NotFoundError("Referral reward");
    if (input.action === "paid" && reward.state === "paid") return reward;
    if (input.action === "paid" && reward.state !== "owed") {
      throw new ConflictError(`This reward is ${reward.state}, so there is nothing to pay.`);
    }
    if (input.action === "void" && reward.state === "void") return reward;
    const [after] = await tx.update(schema.referralReward).set({
      state: input.action,
      ...(input.action === "paid" ? { paidAt: new Date() } : {}),
      note: input.note?.trim() || reward.note,
      updatedAt: new Date(),
    }).where(eq(schema.referralReward.id, reward.id)).returning();
    await audit(tx, ctx, `referral_reward.${input.action}`, "referral_reward", reward.id, reward, after);
    return after!;
  });
}

/* ------------------------------------------------------------ the worker */

/**
 * The worker's actor, with exactly the one permission a credit note reward
 * needs, named rather than inherited from a role.
 */
function rewardActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["invoice:credit"], agentId: "referrals" };
}

/**
 * Grant every reward that has come due.
 *
 * Due: a referred customer whose first job (the earliest not cancelled) has
 * invoices, all of them paid, with no reward row yet. The row is claimed
 * first, under the unique index, so a second worker pass finds it and
 * stops; a credit note is then raised under an idempotency key named for the
 * reward, so a retry of a half finished grant returns the note it already
 * made rather than a second one. A credit note that is refused takes its
 * claim with it, and the next pass tries again.
 */
export async function grantDue(db: Database, organizationId: string): Promise<{ granted: number }> {
  const ctx: ServiceContext = { actor: rewardActor(organizationId), db };
  const due = await inTenant(ctx, async (tx) => {
    const settings = await settingsWithin(tx, organizationId);
    if (settings.reward === "none") return [];
    const candidates = await tx.select({
      id: schema.customer.id, referrerId: schema.customer.referredByCustomerId, name: schema.customer.name,
    }).from(schema.customer)
      .leftJoin(schema.referralReward, eq(schema.referralReward.referredCustomerId, schema.customer.id))
      .where(and(
        isNotNull(schema.customer.referredByCustomerId),
        isNull(schema.customer.deletedAt),
        isNull(schema.referralReward.id),
      )).limit(200);

    const out: { referredId: string; referrerId: string; jobId: string; name: string; kind: "credit_note" | "owed"; amount: string }[] = [];
    for (const c of candidates) {
      const [first] = await tx.select({ id: schema.job.id }).from(schema.job)
        .where(and(eq(schema.job.customerId, c.id), ne(schema.job.status, "cancelled"), isNull(schema.job.deletedAt)))
        .orderBy(asc(schema.job.createdAt)).limit(1);
      if (!first) continue;
      const invoices = await tx.select({ status: schema.invoice.status }).from(schema.invoice)
        .where(and(eq(schema.invoice.jobId, first.id), isNull(schema.invoice.deletedAt),
          inArray(schema.invoice.status, ["open", "partially_paid", "paid"])));
      const decision = rf.rewardDue({
        settings, referrerId: c.referrerId!, referredId: c.id, alreadyRewarded: false,
        firstJobPaid: invoices.length > 0 && invoices.every((i) => i.status === "paid"),
      });
      if (!decision.grant) continue;
      out.push({ referredId: c.id, referrerId: c.referrerId!, jobId: first.id, name: c.name, kind: decision.kind, amount: decision.amount });
    }
    return out;
  });

  let granted = 0;
  for (const reward of due) {
    const claimed = await inTenant(ctx, async (tx) => {
      const [row] = await tx.insert(schema.referralReward).values({
        organizationId,
        referrerCustomerId: reward.referrerId,
        referredCustomerId: reward.referredId,
        jobId: reward.jobId,
        kind: reward.kind,
        amount: reward.amount,
        state: reward.kind === "owed" ? "owed" : "credited",
      }).onConflictDoNothing().returning({ id: schema.referralReward.id });
      return row ?? null;
    });
    if (!claimed) continue;
    if (reward.kind === "credit_note") {
      try {
        const note = await creditNotes.create({ ...ctx, idempotencyKey: `referral-reward:${claimed.id}` }, {
          customerId: reward.referrerId,
          reason: "goodwill",
          note: `Referral reward: thank you for sending ${reward.name}.`,
          lines: [{ name: `Referral reward for ${reward.name}`, quantity: "1", unitPrice: reward.amount }],
          draft: false,
          apply: false,
        });
        await inTenant(ctx, (tx) => tx.update(schema.referralReward).set({ creditNoteId: note.id, updatedAt: new Date() })
          .where(eq(schema.referralReward.id, claimed.id)));
      } catch (error) {
        await inTenant(ctx, (tx) => tx.delete(schema.referralReward).where(eq(schema.referralReward.id, claimed.id)));
        console.error(`[worker] referral reward for ${reward.referredId} was not granted:`,
          error instanceof Error ? error.message : error);
        continue;
      }
    }
    await inTenant(ctx, (tx) => audit(tx, ctx, "referral_reward.granted", "referral_reward", claimed.id, null, reward));
    granted += 1;
  }
  return { granted };
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getReferrals: (ctx: ServiceContext) => overview(ctx),
  getCustomerReferral: (ctx: ServiceContext, input: { id: string }) => forCustomer(ctx, input.id),
  setCustomerReferrer: (ctx: ServiceContext, input: {
    id: string; referrerId: string | null; replace?: boolean | undefined;
  }) => setReferredBy(ctx, { customerId: input.id, referrerId: input.referrerId, replace: input.replace }),
  setReferralSettings: (ctx: ServiceContext, input: { reward: string; amount?: string | undefined }) =>
    setSettings(ctx, input),
  settleReferralReward: (ctx: ServiceContext, input: { id: string; action: "paid" | "void"; note?: string | undefined }) =>
    settleReward(ctx, input),
  viewPortalReferral: (db: Database, input: { token: string }) => forPortal(db, input),
} as const;
