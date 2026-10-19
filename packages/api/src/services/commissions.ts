import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, assertCan, labor, ledger, money as m, time, work, type Actor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, audit, timezoneOf, ConflictError, NotFoundError, UnprocessableError,
  type ServiceContext,
} from "./context";
import { writePosting } from "./ledger";
import { closedPeriodCovering } from "./payroll";
import { refusingDuplicate } from "./duplicates";

/**
 * COMMISSION
 *
 * A COMMISSION IS A LIABILITY THE MOMENT IT IS EARNED.
 *
 * `packages/core/src/ledger` argues at length that a deposit is money held
 * against work not yet done and that booking it as revenue overstates the
 * month, pays commission on work that has not happened, and leaves a company
 * taking fifty per cent up front unable to read its own profit and loss. This
 * is the same error with the sign reversed, and it is made just as often.
 *
 * The technician sold the job. The company owes them. It has not paid them and
 * will not until the payroll run, and if it shut its doors that afternoon it
 * would still owe it. So earning posts an expense and a liability, and paying
 * is a separate event that clears the liability. A product that records
 * commission as a number on a report has a company whose accounts never show
 * what it owes its own people.
 *
 * NONE OF THE ARITHMETIC IS HERE. `packages/core/src/labor` has carried
 * `computeCommission`, `splitCommission` and `clawbackFor` since before this
 * file existed, with no caller outside its own tests: the splits go through
 * `money.allocate` so the parts add back to the whole exactly, and the
 * refusals (a margin plan with no cost, a plan with no note, a job with
 * nobody to pay) are the feature. This file resolves the facts out of the
 * database, hands them over, and records what came back.
 *
 * TWO COMMISSION PERMISSIONS EXIST IN THE CATALOGUE, read and configure, and
 * both writes here take `commission:configure`. Declaring a plan and settling
 * an earning under it are different acts and a larger product would separate
 * them, but inventing a third permission would create a power that no role
 * preset grants and that nobody could therefore hold, which is worse than a
 * coarse one.
 */

const usd = (value: string) => m.money(value, "USD");

/* ------------------------------------------------------------------ plans */

export interface PlanInput {
  label: string;
  basis: labor.CommissionBasisKey;
  /** "0.08" is eight per cent. Required for a percentage basis. */
  rate?: string | null | undefined;
  /** Required for a flat basis. */
  flatAmount?: string | null | undefined;
  /** What a technician is shown when they ask how the number was worked out. */
  note: string;
}

/**
 * Declare a plan.
 *
 * SUPERSEDED, NOT EDITED, the same way an overtime policy is. A plan that can
 * be edited reprices commissions that have already been earned and, in the
 * case of a plan edited downward, paid. `deactivate` and a new declaration are
 * the supported path, and the earned rows freeze the basis and rate anyway so
 * that even a plan deleted outright cannot move what was paid under it.
 *
 * The basis is not defaulted, for the same reason the overtime policy's
 * on-call treatment is not. Every basis rewards something, what it rewards is
 * usually not what the owner meant, and core carries a sentence per basis
 * saying what it is wrong about. `bases()` below publishes those sentences so
 * the choice is made with them on the screen rather than in a help article
 * nobody opens.
 */
export async function declarePlan(ctx: ServiceContext, input: PlanInput) {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    const label = input.label.trim();
    if (label === "") throw new ConflictError("A commission plan needs a name.");

    const spec = labor.COMMISSION_BASIS[input.basis];
    if (!spec) {
      throw new ConflictError(
        `"${String(input.basis)}" is not a commission basis. One of: ${labor.COMMISSION_BASES.join(", ")}.`,
      );
    }

    /**
     * The note is checked here as well as in core, and the duplication is
     * deliberate. Core refuses to COMPUTE under a noteless plan, which is the
     * guarantee; refusing to STORE one means the operator finds out while they
     * are writing the plan rather than weeks later when the first job under it
     * will not settle.
     */
    if (input.note.trim() === "") {
      throw new ConflictError(
        "A commission plan needs a note saying how it works. It is what a technician is shown "
        + "when they ask how the number was worked out, and core refuses to compute without one.",
      );
    }

    if (spec.needs === "rate") {
      if (!input.rate) throw new ConflictError(`A ${spec.label.toLowerCase()} plan needs a rate, such as "0.08" for eight per cent.`);
      const parsed = m.money(input.rate, "USD");
      if (!m.isPositive(parsed)) throw new ConflictError("A commission rate of zero is not a plan. Leave the plan off instead.");
    } else {
      if (!input.flatAmount) throw new ConflictError(`A ${spec.label.toLowerCase()} plan needs an amount per job.`);
      if (!m.isPositive(usd(input.flatAmount))) {
        throw new ConflictError("A flat commission of zero is not a plan. Leave the plan off instead.");
      }
    }

    const [row] = await tx.insert(schema.commissionPlan).values({
      organizationId: ctx.actor.organizationId,
      label,
      basis: input.basis,
      /**
       * The field the other basis does not use is stored as null rather than
       * zero. A flat plan carrying a rate of "0" reads, to anything that looks
       * at the row later, as a percentage plan paying nothing.
       */
      rate: spec.needs === "rate" ? input.rate! : null,
      flatAmount: spec.needs === "flat" ? input.flatAmount! : null,
      note: input.note.trim(),
    }).returning();

    await audit(tx, ctx, "commission_plan.declared", "commission_plan", row!.id, null, row!);
    return shapePlan(row!);
  });
}

/** Stop using a plan without destroying what was earned under it. */
export async function deactivatePlan(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    const [before] = await tx.select().from(schema.commissionPlan)
      .where(and(
        eq(schema.commissionPlan.id, input.id),
        eq(schema.commissionPlan.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!before) throw new NotFoundError("Commission plan");

    const [after] = await tx.update(schema.commissionPlan)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.commissionPlan.id, input.id))
      .returning();

    await audit(tx, ctx, "commission_plan.deactivated", "commission_plan", input.id, before, after!);
    return shapePlan(after!);
  });
}

export async function plans(ctx: ServiceContext) {
  return guardedRead(ctx, "commission:read", async (tx) => {
    const rows = await tx.select().from(schema.commissionPlan)
      .where(eq(schema.commissionPlan.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.commissionPlan.label));
    return rows.map(shapePlan);
  });
}

function shapePlan(row: typeof schema.commissionPlan.$inferSelect) {
  const spec = labor.COMMISSION_BASIS[row.basis];
  return {
    id: row.id,
    label: row.label,
    basis: row.basis,
    rate: row.rate,
    flatAmount: row.flatAmount,
    note: row.note,
    active: row.active,
    /** Travels with the plan everywhere it is shown. See `bases()`. */
    wrongAbout: spec.wrongAbout,
  };
}

/**
 * The four bases, each with what it is WRONG about.
 *
 * Published rather than kept for a help page, for the same reason the
 * attribution models in marketing publish theirs and the rating caveats travel
 * with the rating. Somebody picking a commission basis is writing the
 * instruction their technicians will follow for years, usually in about ninety
 * seconds, and the sentence that would have changed their mind has to be on
 * the screen where the choice is made.
 */
export async function bases(ctx: ServiceContext) {
  return guardedRead(ctx, "commission:read", async () =>
    labor.COMMISSION_BASES.map((key) => {
      const spec = labor.COMMISSION_BASIS[key];
      return {
        key, label: spec.label, meaning: spec.meaning,
        wrongAbout: spec.wrongAbout, needs: spec.needs,
      };
    }));
}

/* ------------------------------------------- an item's own rate, the choice */

/**
 * HOW AN ITEM'S OWN COMMISSION RATE AND THE PLAN COMBINE ON A LINE.
 *
 * A price book item can carry its own rate (M06), and which of that and the
 * plan applies on a line priced from the item is the company's decision,
 * made once for everybody: the plan only (the default, which is what was
 * paid before the choice existed), the item's rate instead, whichever pays
 * more, or the item's rate on top. The arithmetic and the four sentences are
 * core's (`labor.ITEM_RATE_RULE`).
 *
 * Kept in `organization.settings.commission` and read through core, so a
 * hand edited blob reads as the plan only. Deciding it is a statement about
 * what people are paid, so `commission:configure`, the permission that
 * declares a plan; audited with the choice before and after.
 *
 * A CHANGE APPLIES FROM THEN ON. A commission is worked out when it is
 * settled, under the choice in force at that moment, and the choice is
 * frozen onto the earning (`commission_event.item_rule`), so changing it
 * never reprices an earning already made, and a reversal of one recomputes
 * under the choice it was made under.
 */
export async function itemRuleWithin(tx: Database, organizationId: string): Promise<labor.ItemRateRule> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return labor.readItemRateRule(((row?.settings ?? {}) as Record<string, unknown>)["commission"]);
}

export interface ItemRuleView {
  rule: labor.ItemRateRule;
  /** Each choice in the words the screen shows beside it, the plan only first. */
  rules: { rule: labor.ItemRateRule; label: string; meaning: string }[];
}

const ruleView = (rule: labor.ItemRateRule): ItemRuleView => ({
  rule,
  rules: labor.ITEM_RATE_RULES.map((key) => ({
    rule: key, label: labor.ITEM_RATE_RULE[key].label, meaning: labor.ITEM_RATE_RULE[key].meaning,
  })),
});

export async function itemRule(ctx: ServiceContext): Promise<ItemRuleView> {
  return guardedRead(ctx, "commission:read", async (tx) => ruleView(await itemRuleWithin(tx, ctx.actor.organizationId)));
}

export async function setItemRule(ctx: ServiceContext, input: { rule: labor.ItemRateRule }): Promise<ItemRuleView> {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    if (!(labor.ITEM_RATE_RULES as readonly string[]).includes(input.rule)) {
      throw new ConflictError(`"${String(input.rule)}" is not one of the choices. One of: ${labor.ITEM_RATE_RULES.join(", ")}.`);
    }
    const before = await itemRuleWithin(tx, ctx.actor.organizationId);
    /** The same choice again, from a retry or a second click, changes nothing and is not audited twice. */
    if (before === input.rule) return ruleView(before);
    await mergeCommissionSettings(tx, ctx.actor.organizationId, { itemRule: input.rule });
    await audit(tx, ctx, "commission_item_rule.set", "organization", ctx.actor.organizationId,
      { itemRule: before }, { itemRule: input.rule });
    return ruleView(input.rule);
  });
}

/**
 * Change some of `organization.settings.commission` and keep the rest. The
 * item rule and settling on payment share the object, and replacing it whole
 * would turn one of them off by saving the other.
 */
async function mergeCommissionSettings(tx: Database, organizationId: string, patch: Record<string, unknown>): Promise<void> {
  await tx.update(schema.organization).set({
    settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || jsonb_build_object('commission',
      coalesce(${schema.organization.settings}->'commission', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
    updatedAt: new Date(),
  }).where(eq(schema.organization.id, organizationId));
}

/**
 * An invoice's lines as a commission reads them: what each charged, net of
 * its own discount and before tax, and the rate on the price book VERSION it
 * was priced from. The version, never the item's version today, because a
 * rate raised in the spring must not reprice what was sold in the winter;
 * that is the whole reason a line points at a version.
 */
async function linesOf(tx: Database, invoiceId: string) {
  const rows = await tx.select({
    id: schema.invoiceLine.id,
    name: schema.invoiceLine.name,
    net: schema.invoiceLine.lineTotal,
    versionId: schema.invoiceLine.priceBookItemVersionId,
    itemRate: schema.priceBookItemVersion.commissionRate,
  }).from(schema.invoiceLine)
    .leftJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.id, schema.invoiceLine.priceBookItemVersionId))
    .where(eq(schema.invoiceLine.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceLine.sortOrder), asc(schema.invoiceLine.id));
  return {
    lines: rows.map((row): labor.CommissionLine => ({
      lineId: row.id, label: row.name, net: usd(row.net), itemRate: row.itemRate,
    })),
    versions: new Map(rows.map((row) => [row.id, row.versionId])),
  };
}

/** What a line paid, as the earning keeps it. */
function lineRecords(
  lines: readonly labor.CommissionLineResult[] | undefined, versions: ReadonlyMap<string, string | null>,
): schema.CommissionLineRecord[] {
  return (lines ?? []).map((line) => ({
    invoiceLineId: line.lineId,
    label: line.label,
    net: m.toString(line.net),
    priceBookItemVersionId: versions.get(line.lineId) ?? null,
    itemRate: line.itemRate,
    planPart: m.toString(line.planPart),
    itemPart: line.itemPart ? m.toString(line.itemPart) : null,
    paid: m.toString(line.paid),
    source: line.source,
  }));
}

/* --------------------------------------------------------------- settling */

export interface ShareInput {
  technicianId: string;
  /** A weight, not a percentage. "2" and "1" is a two thirds, one third split. */
  weight: string;
}

export interface SettleInput {
  invoiceId: string;
  /** Omitted when the company runs exactly one active plan. */
  planId?: string | undefined;
  /** Omitted to split equally between the technicians assigned to the job. */
  shares?: readonly ShareInput[] | undefined;
  /**
   * When it was earned, which is the only thing that decides which pay period
   * it falls in. Defaults to now; given explicitly by a company settling an
   * invoice from last month, and refused into a pay period that has already
   * been closed.
   */
  occurredAt?: Date | undefined;
  /** Why it is shared this way, when the office changed the even split. Kept on the earning and in each part's explanation. */
  splitNote?: string | undefined;
  /** The split the screen proposed, for the audit to say whether it was changed. */
  proposed?: readonly labor.CommissionShare[] | undefined;
  /** The standing shares a split settled as proposed was made from, in words. Kept on the earning and in each part. */
  standingNote?: string | undefined;
}

/**
 * EARN THE COMMISSION ON AN INVOICE.
 *
 * Three questions, and every field service product gets at least one wrong.
 *
 * ON WHAT. All four bases core knows are supported, because all four are real
 * plans in this industry and a product that does one is wrong for most
 * companies. Revenue here is NET OF TAX AND OF DISCOUNT, which is what the
 * invoice posting recognised as revenue: commission on the tax line pays a
 * technician a share of money owed to a jurisdiction. A margin basis needs a
 * cost, which `costOf` resolves from the facts already recorded against the
 * job, and core refuses outright rather than treating an unknown cost as zero.
 *
 * WHOSE. The split is explicit, or it is derived from the technicians assigned
 * to the job's visits and split evenly. It is never derived from "the lead
 * technician" silently, because the person who sold it and the person who did
 * it are routinely not the same person and a product that assumes they are
 * pays the wrong one. The weights go to `money.allocate`, so the parts add
 * back to the whole exactly and the odd cent goes somewhere rather than
 * disappearing.
 *
 * WHEN. At settlement, recorded with the instant it happened, and that instant
 * is the only thing that decides which pay period it falls in. A collected
 * basis is REFUSED until the invoice is paid in full: the basis means a share
 * of cash received, and settling it on a part payment would either pay
 * commission on money that has not arrived or require splitting one invoice's
 * commission into instalments, after which a refund has to decide which
 * instalment it came out of.
 *
 * ONCE. The unique index on the invoice is the guard, and it is checked here
 * first so the error is a sentence rather than a constraint violation.
 */
export async function settle(ctx: ServiceContext, input: SettleInput) {
  return guardedWrite(ctx, "commission:configure", (tx) => settleIn(tx, ctx, input));
}

/**
 * Everything settling decides before it writes: the invoice, the plan, the
 * shares, the facts the plan reads, and core's verdict. The preview on the
 * split screen and settling itself both come through here, so what the office
 * is shown is what is settled.
 */
async function prepare(tx: Database, ctx: ServiceContext, input: SettleInput) {
  const [invoice] = await tx.select().from(schema.invoice)
    .where(and(
      eq(schema.invoice.id, input.invoiceId),
      isNull(schema.invoice.deletedAt),
    )).limit(1);
  if (!invoice) throw new NotFoundError("Invoice");

  if (invoice.status === "draft") {
    /**
     * A draft has not been posted to the ledger, so no revenue has been
     * recognised and there is nothing to take a share of. Settling one would
     * create a liability against a sale that may never happen.
     */
    throw new ConflictError(
      `Invoice ${invoice.number} is still a draft. Nothing has been earned on it yet.`,
    );
  }
  if (invoice.status === "void" || invoice.status === "written_off") {
    throw new ConflictError(
      `Invoice ${invoice.number} is ${invoice.status.replace("_", " ")}. `
      + "Commission is not earned on an invoice the company was never paid for.",
    );
  }

  const [existing] = await tx.select({ id: schema.commissionEvent.id })
    .from(schema.commissionEvent)
    .where(and(
      eq(schema.commissionEvent.organizationId, ctx.actor.organizationId),
      eq(schema.commissionEvent.invoiceId, invoice.id),
    )).limit(1);
  if (existing) {
    throw new ConflictError(
      `Invoice ${invoice.number} has already earned a commission. Settling it again would pay it twice `
      + "and carry the liability twice, and the only symptom is a job appearing in two payroll runs.",
    );
  }

  const plan = await resolvePlan(tx, ctx, input.planId);
  const { shares, standingNote } = await resolveShares(tx, ctx, invoice.jobId, input.shares);

  /**
   * NET REVENUE, matching `ledger.postInvoice`: it credits revenue with the
   * subtotal and debits contra revenue with the discount, so what the
   * company actually earned on this document is the difference. The tax is a
   * liability to a jurisdiction and is not ours to share.
   */
  const revenue = m.subtract(usd(invoice.subtotal), usd(invoice.discountTotal));

  if (plan.basis === "percent_of_collected" && invoice.status !== "paid") {
    throw new ConflictError(
      `Invoice ${invoice.number} has ${invoice.amountPaid} of ${invoice.total} collected. `
      + "This plan pays on what was collected, so it cannot be settled until the invoice is paid in full. "
      + "Settling it now would either pay a share of money that has not arrived, or split one invoice's "
      + "commission into instalments, after which a refund has to decide which instalment it came out of.",
    );
  }

  const cost = invoice.jobId ? await costOf(tx, invoice.jobId) : null;
  const occurredAt = input.occurredAt ?? new Date();
  const rule = await itemRuleWithin(tx, ctx.actor.organizationId);
  /** The plan only does not read the lines, so they are not loaded for it. */
  const { lines, versions } = rule === "plan_only" ? { lines: [], versions: new Map<string, string | null>() } : await linesOf(tx, invoice.id);

  /**
   * BACKDATING INTO A CLOSED PERIOD IS REFUSED.
   *
   * A commission dated into a fortnight that has been exported and paid
   * changes a figure the bureau holds, the technician has been paid on, and
   * tax has been withheld and remitted against. Nothing anywhere would say
   * it moved: the export is already out, and the next one covers a different
   * period. The same argument the accounting close makes about a late
   * invoice pushed into a filed quarter.
   */
  const closed = await closedPeriodCovering(tx, ctx.actor.organizationId, occurredAt);
  if (closed) {
    throw new ConflictError(
      `${occurredAt.toISOString()} falls inside ${closed.label}, which was closed at `
      + `${closed.closedAt.toISOString()} and has been run. Reopen that period if this really belongs `
      + "in it, or date the earning in a period that is still open.",
    );
  }

  const event: labor.CommissionEvent = {
    id: invoice.id,
    jobId: invoice.jobId ?? invoice.id,
    invoiceId: invoice.id,
    occurredAt,
    revenue,
    ...(cost ? { cost } : {}),
    /**
     * Only on the basis that uses it. Recording a collected figure on a
     * revenue plan would imply the plan looked at it.
     */
    ...(plan.basis === "percent_of_collected" ? { collected: revenue } : {}),
    shares: shares.map((share) => ({ personId: share.technicianId, weight: share.weight })),
    ...(rule === "plan_only" ? {} : { lines }),
  };

  const verdict = labor.computeCommission({ ...toCorePlan(plan), itemRule: rule }, event);
  if (!verdict.ok) throw new ConflictError(verdict.reason);
  return { invoice, plan, shares, revenue, cost, occurredAt, verdict, rule, lines: lineRecords(verdict.lines, versions), standingNote };
}

async function settleIn(tx: Database, ctx: ServiceContext, input: SettleInput) {
  const prepared = await prepare(tx, ctx, input);
  const { invoice, plan, shares, revenue, cost, occurredAt, verdict, rule, lines } = prepared;
  const note = input.splitNote?.trim() || null;
  /**
   * A split the office changed is explained by their reason; one settled as
   * proposed with a standing share in it is explained by the standing shares,
   * frozen here because a standing share can be stopped later.
   */
  const standing = note ? null : (input.standingNote ?? prepared.standingNote ?? null);
  const said = (explanation: string) => (note
    ? `${explanation} Shared this way by the office: ${note}`
    : standing ? `${explanation} ${standing}` : explanation);

  const [row] = await tx.insert(schema.commissionEvent).values({
    organizationId: ctx.actor.organizationId,
    planId: plan.id,
    invoiceId: invoice.id,
    jobId: invoice.jobId,
    basis: plan.basis,
    appliedRate: plan.rate,
    appliedFlatAmount: plan.flatAmount,
    revenue: m.toString(revenue),
    cost: cost ? m.toString(cost) : null,
    collected: plan.basis === "percent_of_collected" ? m.toString(revenue) : null,
    total: m.toString(verdict.total),
    occurredAt,
    explanation: verdict.explanation,
    splitNote: note,
    standingNote: standing,
    itemRule: rule,
    lines,
    ledgerTransactionId: null,
  }).returning();

  for (const [index, part] of verdict.parts.entries()) {
    await tx.insert(schema.commissionEntry).values({
      organizationId: ctx.actor.organizationId,
      eventId: row!.id,
      reversalId: null,
      technicianId: part.personId,
      kind: "earned",
      weight: shares[index]!.weight,
      shareIndex: index,
      amount: m.toString(part.amount),
      explanation: said(part.explanation),
      occurredAt,
    });
  }

  /**
   * ZERO POSTS NOTHING. A job that lost money under a margin plan earns no
   * commission, and a posting with no entries is not a posting: it would be
   * a transaction id on a row with nothing behind it, which reads in the
   * register as a commission somebody cannot find.
   */
  let transactionId: string | null = null;
  if (m.isPositive(verdict.total)) {
    transactionId = await writePosting(tx, ctx, ledger.postCommissionEarned({
      commissionEventId: row!.id,
      occurredAt,
      amount: verdict.total,
      ...(invoice.jobId ? { jobId: invoice.jobId } : {}),
      customerId: invoice.customerId,
    }));
    await tx.update(schema.commissionEvent)
      .set({ ledgerTransactionId: transactionId, updatedAt: new Date() })
      .where(eq(schema.commissionEvent.id, row!.id));
  }

  await audit(tx, ctx, "commission.earned", "commission_event", row!.id, null, {
    invoiceId: invoice.id, planId: plan.id, total: m.toString(verdict.total), itemRule: rule,
    parts: verdict.parts.map((p, i) => ({ technicianId: p.personId, weight: shares[i]!.weight, amount: m.toString(p.amount) })),
    ...(input.proposed ? {
      proposed: input.proposed.map((p) => ({ technicianId: p.personId, weight: p.weight })),
      changed: !labor.sameSplit(input.proposed, shares.map((x) => ({ personId: x.technicianId, weight: x.weight }))),
    } : {}),
    ...(note ? { splitNote: note } : {}),
    ...(standing ? { standingNote: standing } : {}),
  });

  return {
    id: row!.id,
    invoiceId: invoice.id,
    planId: plan.id,
    basis: plan.basis,
    revenue: m.toString(revenue),
    cost: cost ? m.toString(cost) : null,
    total: m.toString(verdict.total),
    explanation: verdict.explanation,
    itemRule: rule,
    lines,
    occurredAt,
    ledgerTransactionId: transactionId,
    parts: verdict.parts.map((part, index) => ({
      technicianId: part.personId,
      weight: shares[index]!.weight,
      amount: m.toString(part.amount),
      explanation: said(part.explanation),
    })),
  };
}

/* -------------------------------------------------------------- reversing */

export interface ReverseInput {
  invoiceId: string;
  reason: labor.CreditReason;
  /** How much of the net revenue came back off. */
  creditedRevenue: string;
  /** How much of the cost came back off with it, on a margin plan. */
  creditedCost?: string | null | undefined;
  /** What caused it: "invoice.written_off", "payment.refunded". */
  causeType: string;
  /** The id of the thing that caused it. Unique per event, so one cause reverses once. */
  causeId: string;
}

/**
 * TAKE THE COMMISSION BACK OFF.
 *
 * A plan with no reversal is a plan under which a company pays commission on
 * money it never received. The customer disputes the bill in April, the money
 * goes back, and the technician keeps eight per cent of a job nobody paid for.
 *
 * COMPUTED AGAINST THE CUMULATIVE CREDIT AND THEN NETTED AGAINST WHAT HAS
 * ALREADY COME BACK. This is the part that looks like needless arithmetic and
 * is not. Applying each credit to the pristine original and taking the
 * difference is right for a plain percentage and silently wrong for anything
 * with a floor, a tier or a margin, because those are not linear in the
 * credit: two credits of five hundred would not reverse the same amount as one
 * credit of a thousand. So the whole commission is recomputed as though the
 * cumulative credit had always applied, and what has already been reversed is
 * subtracted from that.
 *
 * THE CREDIT MAY NOT EXCEED WHAT WAS EARNED ON. Without that guard a repeated
 * or mistyped credit drives the liability negative and the technician owes the
 * company money for a job they were paid for once.
 *
 * `causeType` and `causeId` are unique per event, so the same write-off cannot
 * reverse the same commission twice. That is not a theoretical retry: a human
 * clicking twice, or a job that retries, would otherwise take the money back
 * off somebody as many times as it ran.
 *
 * THE REVERSAL LANDS IN THE PERIOD THE CREDIT HAPPENED IN, never the one the
 * commission was paid in. Core sets out why: the earlier period was paid, tax
 * was withheld on the amount shown, and that withholding was remitted and
 * reported. Reaching back means amending a filing, and in the meantime the
 * technician's year to date figures disagree with the ones the tax authority
 * holds.
 */
export async function reverse(ctx: ServiceContext, input: ReverseInput) {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    const [event] = await tx.select().from(schema.commissionEvent)
      .where(and(
        eq(schema.commissionEvent.organizationId, ctx.actor.organizationId),
        eq(schema.commissionEvent.invoiceId, input.invoiceId),
      )).limit(1);
    if (!event) throw new NotFoundError("Commission on that invoice");

    const credited = usd(input.creditedRevenue);
    if (!m.isPositive(credited)) {
      throw new ConflictError(
        "A reversal of nothing is not a reversal. Give the amount of revenue that came back off.",
      );
    }

    const priorReversals = await tx.select().from(schema.commissionReversal)
      .where(eq(schema.commissionReversal.eventId, event.id))
      .orderBy(asc(schema.commissionReversal.occurredAt));

    const duplicate = priorReversals.find(
      (row) => row.causeType === input.causeType && row.causeId === input.causeId,
    );
    if (duplicate) {
      throw new ConflictError(
        `This commission has already been reversed for ${input.causeType} ${input.causeId}. `
        + "Reversing it again would take the money off the technician a second time for one credit.",
      );
    }

    const priorCredited = m.sum(priorReversals.map((row) => usd(row.creditedRevenue)), "USD");
    const cumulativeCredited = m.add(priorCredited, credited);
    const earnedOn = usd(event.revenue);

    if (m.compare(cumulativeCredited, earnedOn) > 0) {
      throw new ConflictError(
        `That would credit ${m.toString(cumulativeCredited)} against a commission earned on `
        + `${m.toString(earnedOn)}${m.isPositive(priorCredited) ? ` (${m.toString(priorCredited)} has already been credited)` : ""}. `
        + "You cannot take back more than was earned: the liability would go negative and the technician "
        + "would owe the company money for a job they were paid for once.",
      );
    }

    const cumulativeCost = input.creditedCost
      ? m.add(
          m.sum(priorReversals.map((row) => (row.creditedCost ? usd(row.creditedCost) : m.zero("USD"))), "USD"),
          usd(input.creditedCost),
        )
      : null;

    const earnedEntries = await tx.select().from(schema.commissionEntry)
      .where(and(
        eq(schema.commissionEntry.eventId, event.id),
        eq(schema.commissionEntry.kind, "earned"),
      ))
      .orderBy(asc(schema.commissionEntry.shareIndex));
    if (earnedEntries.length === 0) {
      throw new NotFoundError("Commission shares on that invoice");
    }

    const plan = await planBehind(tx, event);
    const original: labor.CommissionEvent = {
      id: event.id,
      jobId: event.jobId ?? event.invoiceId,
      invoiceId: event.invoiceId,
      occurredAt: event.occurredAt,
      revenue: usd(event.revenue),
      ...(event.cost ? { cost: usd(event.cost) } : {}),
      ...(event.collected ? { collected: usd(event.collected) } : {}),
      /** In share order. See `commission_entry.share_index` for why that matters. */
      shares: earnedEntries.map((row) => ({ personId: row.technicianId, weight: row.weight ?? "1" })),
      /** The lines as they were read when it was earned, so it recomputes to exactly what was paid. */
      ...(event.itemRule === "plan_only" ? {} : {
        lines: event.lines.map((line) => ({
          lineId: line.invoiceLineId, label: line.label, net: usd(line.net), itemRate: line.itemRate,
        })),
      }),
    };

    const verdict = labor.clawbackFor(plan, original, {
      id: input.causeId,
      commissionEventId: event.id,
      occurredAt: new Date(),
      reason: input.reason,
      creditedRevenue: cumulativeCredited,
      ...(cumulativeCost ? { creditedCost: cumulativeCost } : {}),
    });
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    /** What each person has already given back, as a negative. */
    const alreadyBack = new Map<string, m.Money>();
    const previousLines = await tx.select().from(schema.commissionEntry)
      .where(and(
        eq(schema.commissionEntry.eventId, event.id),
        eq(schema.commissionEntry.kind, "reversed"),
      ));
    for (const line of previousLines) {
      alreadyBack.set(
        line.technicianId,
        m.add(alreadyBack.get(line.technicianId) ?? m.zero("USD"), usd(line.amount)),
      );
    }

    const occurredAt = new Date();
    const lines = verdict.lines.map((line, index) => ({
      technicianId: line.personId,
      shareIndex: index,
      /** The cumulative reversal, less what has already come back. */
      amount: m.subtract(line.amount, alreadyBack.get(line.personId) ?? m.zero("USD")),
      explanation: line.explanation,
    }));
    const total = m.sum(lines.map((line) => line.amount), "USD");

    const [row] = await tx.insert(schema.commissionReversal).values({
      organizationId: ctx.actor.organizationId,
      eventId: event.id,
      reason: input.reason,
      creditedRevenue: m.toString(credited),
      creditedCost: input.creditedCost ?? null,
      total: m.toString(total),
      occurredAt,
      explanation: verdict.explanation,
      causeType: input.causeType,
      causeId: input.causeId,
      ledgerTransactionId: null,
    }).returning();

    for (const line of lines) {
      await tx.insert(schema.commissionEntry).values({
        organizationId: ctx.actor.organizationId,
        eventId: event.id,
        reversalId: row!.id,
        technicianId: line.technicianId,
        kind: "reversed",
        weight: null,
        shareIndex: line.shareIndex,
        amount: m.toString(line.amount),
        explanation: line.explanation,
        occurredAt,
      });
    }

    /**
     * The MAGNITUDE goes to the posting, which refuses a negative. A reversal
     * posted with the negative figure would have two negative legs, balance
     * perfectly, and read on a trial balance as a second commission being
     * earned.
     */
    let transactionId: string | null = null;
    if (!m.isZero(total)) {
      transactionId = await writePosting(tx, ctx, ledger.postCommissionReversal({
        commissionReversalId: row!.id,
        occurredAt,
        amount: m.abs(total),
        ...(event.jobId ? { jobId: event.jobId } : {}),
      }));
      await tx.update(schema.commissionReversal)
        .set({ ledgerTransactionId: transactionId, updatedAt: new Date() })
        .where(eq(schema.commissionReversal.id, row!.id));
    }

    await audit(tx, ctx, "commission.reversed", "commission_reversal", row!.id, null, {
      eventId: event.id, reason: input.reason,
      creditedRevenue: m.toString(credited), total: m.toString(total),
    });

    return {
      id: row!.id,
      eventId: event.id,
      reason: input.reason,
      creditedRevenue: m.toString(credited),
      total: m.toString(total),
      occurredAt,
      explanation: verdict.explanation,
      ledgerTransactionId: transactionId,
      lines: lines.map((line) => ({
        technicianId: line.technicianId,
        amount: m.toString(line.amount),
        explanation: line.explanation,
      })),
    };
  });
}

/* ----------------------------------------------------------------- reads */

/**
 * What has been earned, what has come back, and what is still owed.
 *
 * `owed` is the figure that should agree with the commission payable balance
 * in the ledger, and a test asserts that it does. They are computed from
 * different rows by different code, which is the only way the agreement means
 * anything.
 */
export async function earnings(
  ctx: ServiceContext,
  input: { technicianId?: string | undefined; from?: string | undefined; to?: string | undefined } = {},
) {
  return guardedRead(ctx, "commission:read", async (tx) => {
    /**
     * Whole days in the company's zone. A sale at eight in the evening in
     * Chicago on the last day of a pay period is that period's, and read as a
     * UTC day it was paid in the next one.
     */
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const rows = await tx.select({
      entry: schema.commissionEntry,
      technicianName: schema.technician.displayName,
      invoiceId: schema.commissionEvent.invoiceId,
      invoiceNumber: schema.invoice.number,
      itemRule: schema.commissionEvent.itemRule,
    }).from(schema.commissionEntry)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.commissionEntry.technicianId))
      .innerJoin(schema.commissionEvent, eq(schema.commissionEvent.id, schema.commissionEntry.eventId))
      .innerJoin(schema.invoice, eq(schema.invoice.id, schema.commissionEvent.invoiceId))
      .where(and(
        eq(schema.commissionEntry.organizationId, ctx.actor.organizationId),
        ...(input.technicianId ? [eq(schema.commissionEntry.technicianId, input.technicianId)] : []),
        ...(input.from ? [gte(schema.commissionEntry.occurredAt, time.startOfDayIn(input.from, zone))] : []),
        ...(input.to ? [lt(schema.commissionEntry.occurredAt, time.startOfDayIn(time.nextDay(input.to), zone))] : []),
      ))
      .orderBy(asc(schema.commissionEntry.occurredAt));

    const entries = rows.map((row) => ({
      id: row.entry.id,
      technicianId: row.entry.technicianId,
      technicianName: row.technicianName,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      kind: row.entry.kind,
      amount: row.entry.amount,
      explanation: row.entry.explanation,
      /** Which of the company's choices the earning behind it was made under. */
      itemRule: labor.readItemRateRule({ itemRule: row.itemRule }),
      occurredAt: row.entry.occurredAt,
      paidAt: row.entry.paidAt,
    }));

    const amounts = entries.map((entry) => usd(entry.amount));
    return {
      entries,
      earned: m.toString(m.sum(
        entries.filter((e) => e.kind === "earned").map((e) => usd(e.amount)), "USD")),
      reversed: m.toString(m.sum(
        entries.filter((e) => e.kind === "reversed").map((e) => usd(e.amount)), "USD")),
      owed: m.toString(m.sum(
        entries.filter((e) => e.paidAt === null).map((e) => usd(e.amount)), "USD")),
      net: m.toString(m.sum(amounts, "USD")),
    };
  });
}

/* --------------------------------------------------- shared, from a screen */

/** A person in a split: on the job or added by the office, with what they would be paid. */
export interface SplitPerson {
  technicianId: string;
  name: string;
  /** Assigned to one of the job's visits. */
  onJob: boolean;
  /** Their weight in the split proposed (even, or shaped by standing shares), or "0" for somebody the office added. */
  proposedWeight: string;
  /** Their weight in the split shown. */
  weight: string;
  /** What they would be paid under it. Null when the split cannot be settled. */
  amount: string | null;
  explanation: string | null;
}

export interface SplitProposal {
  invoice: {
    id: string; number: string; status: string; customerName: string;
    jobId: string | null; jobNumber: string | null;
  };
  /** The active plans, for choosing one when there are several. */
  plans: { id: string; label: string }[];
  /** Everybody else the office could add to the split: the person who sold it is not always on the visits. */
  others: { technicianId: string; name: string }[];
  planId: string | null;
  planLabel: string | null;
  revenue: string | null;
  total: string | null;
  explanation: string | null;
  people: SplitPerson[];
  /** The split shown differs from the one proposed, so settling it needs a reason. */
  changed: boolean;
  /** The standing shares that shaped the proposal. Empty when it is the even split. */
  standing: { technicianId: string; name: string; percent: number; applies: "always" | "as_lead"; reason: string }[];
  /** The proposal in words when a standing share shaped it. */
  standingSentence: string | null;
  /** Why standing shares on this job could not all be honoured, so the even split was proposed. */
  standingConflict: string | null;
  /** Why it cannot be settled as shown, in a sentence, or null. */
  refusal: string | null;
  /**
   * How an item's own rate and the plan combine, and what each line paid
   * under it: the company's choice now, or the one the earning was made
   * under once it is settled. `lines` is empty under the plan only, which
   * does not read them.
   */
  itemRule: labor.ItemRateRule;
  itemRuleLabel: string;
  lines: schema.CommissionLineRecord[];
  /** Already settled: what was paid to whom, and the reason given for the split. */
  settled: SettledSplit | null;
}

export interface SettledSplit {
  eventId: string; total: string; occurredAt: Date; splitNote: string | null;
  /** The standing shares it was settled as proposed with, in words, or null. */
  standingNote: string | null;
  /** How it was worked out, in the words the people paid read. */
  explanation: string;
  itemRule: labor.ItemRateRule;
  lines: schema.CommissionLineRecord[];
  parts: { technicianId: string; name: string; weight: string | null; amount: string }[];
}

/** The people on a job's visits, by name. Who a shared commission is proposed between. */
async function peopleOnJob(tx: Database, jobId: string | null): Promise<{ technicianId: string; name: string; isLead: boolean }[]> {
  if (!jobId) return [];
  return tx.select({
    technicianId: schema.visitAssignment.technicianId,
    name: schema.technician.displayName,
    /** Led at least one of the job's visits, which is when a lead's standing share applies. */
    isLead: sql<boolean>`bool_or(${schema.visitAssignment.isLead})`,
  })
    .from(schema.visitAssignment)
    .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
    .innerJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
    /** Not a visit recorded from history: what it earned was settled in the old system. */
    .where(and(eq(schema.visit.jobId, jobId), eq(schema.visit.fromHistory, false)))
    .groupBy(schema.visitAssignment.technicianId, schema.technician.displayName)
    .orderBy(asc(schema.technician.displayName), asc(schema.visitAssignment.technicianId));
}

/** The standing shares in force for these people, with their names for the sentence. */
async function standingFor(tx: Database, organizationId: string, technicianIds: readonly string[]): Promise<labor.StandingShare[]> {
  if (technicianIds.length === 0) return [];
  const rows = await tx.select({
    technicianId: schema.commissionStandingShare.technicianId,
    percent: schema.commissionStandingShare.percent,
    applies: schema.commissionStandingShare.applies,
    reason: schema.commissionStandingShare.reason,
    name: schema.technician.displayName,
  }).from(schema.commissionStandingShare)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.commissionStandingShare.technicianId))
    .where(and(
      eq(schema.commissionStandingShare.organizationId, organizationId),
      inArray(schema.commissionStandingShare.technicianId, [...technicianIds]),
      isNull(schema.commissionStandingShare.endedAt),
    ));
  return rows.map((row) => ({ personId: row.technicianId, percent: row.percent, applies: row.applies, reason: row.reason, name: row.name }));
}

/**
 * The split proposed between the people on a job: even, or shaped by their
 * standing shares. The one place the screen, settling from it and settling a
 * page of them at once read it from, so all three propose the same split.
 */
async function proposedWithin(tx: Database, organizationId: string, jobId: string | null) {
  const onJob = await peopleOnJob(tx, jobId);
  const split = labor.proposeSplit(
    onJob.map((p) => ({ personId: p.technicianId, isLead: p.isLead })),
    await standingFor(tx, organizationId, onJob.map((p) => p.technicianId)),
  );
  return { onJob, split };
}

/**
 * A SHARED COMMISSION, WORKED OUT BEFORE IT IS SETTLED.
 *
 * The even split between the people on the job is proposed, which is what
 * settling without shares has always done, and core works out each person's
 * part under the plan. With `shares`, the office's own split instead, worked
 * out the same way, so what the screen shows is exactly what settling it
 * writes: both come through `prepare`. Anything settling would refuse (a
 * margin plan with no cost, two active plans and none named, a split of
 * zeros) comes back as `refusal`, in the same words, rather than as an error.
 *
 * `commission:read`, because it writes nothing.
 */
export async function proposal(
  ctx: ServiceContext,
  input: { invoiceId: string; planId?: string | undefined; shares?: readonly ShareInput[] | undefined },
): Promise<SplitProposal> {
  return guardedRead(ctx, "commission:read", async (tx) => {
    const [row] = await tx.select({
      invoice: schema.invoice, customerName: schema.customer.name,
      jobNumber: schema.job.number, jobPrefix: schema.job.numberPrefix,
    }).from(schema.invoice)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
      .leftJoin(schema.job, eq(schema.job.id, schema.invoice.jobId))
      .where(and(
        eq(schema.invoice.organizationId, ctx.actor.organizationId),
        eq(schema.invoice.id, input.invoiceId),
        isNull(schema.invoice.deletedAt),
      )).limit(1);
    if (!row) throw new NotFoundError("Invoice");
    const invoice = row.invoice;

    const { onJob, split } = await proposedWithin(tx, ctx.actor.organizationId, invoice.jobId);
    const proposed = split.shares;
    const given: ShareInput[] = input.shares && input.shares.length > 0
      ? input.shares.map((s) => ({ technicianId: s.technicianId, weight: s.weight }))
      : proposed.map((s) => ({ technicianId: s.personId, weight: s.weight }));

    const added = given.filter((s) => !onJob.some((p) => p.technicianId === s.technicianId)).map((s) => s.technicianId);
    const names = new Map(onJob.map((p) => [p.technicianId, p.name]));
    if (added.length > 0) {
      const extra = await tx.select({ id: schema.technician.id, name: schema.technician.displayName })
        .from(schema.technician)
        .where(and(eq(schema.technician.organizationId, ctx.actor.organizationId), inArray(schema.technician.id, added)));
      for (const person of extra) names.set(person.id, person.name);
    }

    const plans = await tx.select({ id: schema.commissionPlan.id, label: schema.commissionPlan.label })
      .from(schema.commissionPlan)
      .where(and(eq(schema.commissionPlan.organizationId, ctx.actor.organizationId), eq(schema.commissionPlan.active, true)))
      .orderBy(asc(schema.commissionPlan.label));

    const everybody = await tx.select({ technicianId: schema.technician.id, name: schema.technician.displayName })
      .from(schema.technician)
      .where(eq(schema.technician.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.technician.displayName));

    const [event] = await tx.select().from(schema.commissionEvent)
      .where(and(eq(schema.commissionEvent.organizationId, ctx.actor.organizationId), eq(schema.commissionEvent.invoiceId, invoice.id)))
      .limit(1);
    const settled = event ? await settledSplit(tx, event) : null;
    const rule = settled?.itemRule ?? await itemRuleWithin(tx, ctx.actor.organizationId);

    let worked: Awaited<ReturnType<typeof prepare>> | null = null;
    let refusal: string | null = null;
    if (!settled) {
      try {
        worked = await prepare(tx, ctx, { invoiceId: invoice.id, ...(input.planId ? { planId: input.planId } : {}), shares: given });
      } catch (error) {
        /** A refusal settling would make, said on the screen instead of thrown at it. */
        if (error instanceof ConflictError || error instanceof NotFoundError) refusal = error.message;
        else throw error;
      }
    }

    const people: SplitPerson[] = [
      ...onJob.map((p) => p.technicianId),
      ...given.map((s) => s.technicianId).filter((id) => !onJob.some((p) => p.technicianId === id)),
    ].filter((id, i, all) => all.indexOf(id) === i).map((technicianId) => {
      const index = given.findIndex((s) => s.technicianId === technicianId);
      const part = worked && index >= 0 ? worked.verdict.parts[index] : undefined;
      return {
        technicianId,
        name: names.get(technicianId) ?? "Unknown",
        onJob: onJob.some((p) => p.technicianId === technicianId),
        proposedWeight: proposed.find((s) => s.personId === technicianId)?.weight ?? "0",
        weight: index >= 0 ? given[index]!.weight : "0",
        amount: part ? m.toString(part.amount) : null,
        explanation: part ? part.explanation : null,
      };
    });

    return {
      invoice: {
        id: invoice.id, number: work.documentNumber(invoice.numberPrefix, invoice.number), status: invoice.status,
        customerName: row.customerName, jobId: invoice.jobId,
        jobNumber: row.jobNumber === null ? null : work.documentNumber(row.jobPrefix, row.jobNumber),
      },
      plans,
      others: everybody.filter((p) => !given.some((s) => s.technicianId === p.technicianId)
        && !onJob.some((o) => o.technicianId === p.technicianId)),
      planId: worked?.plan.id ?? input.planId ?? null,
      planLabel: worked?.plan.label ?? null,
      revenue: worked ? m.toString(worked.revenue) : null,
      total: worked ? m.toString(worked.verdict.total) : null,
      explanation: worked?.verdict.explanation ?? null,
      people,
      changed: !labor.sameSplit(proposed, given.map((s) => ({ personId: s.technicianId, weight: s.weight }))),
      standing: split.applied.map((rule) => ({
        technicianId: rule.personId, name: rule.name ?? "", percent: rule.percent, applies: rule.applies, reason: rule.reason,
      })),
      standingSentence: split.sentence,
      standingConflict: split.conflict,
      refusal: settled ? `Invoice ${work.documentNumber(invoice.numberPrefix, invoice.number)} has already earned its commission.` : refusal,
      itemRule: rule,
      itemRuleLabel: labor.ITEM_RATE_RULE[rule].label,
      lines: settled?.lines ?? worked?.lines ?? [],
      settled,
    };
  });
}

/** An earning as it was settled: each person's part, their weight and the reason given for the split. */
async function settledSplit(tx: Database, event: typeof schema.commissionEvent.$inferSelect): Promise<SettledSplit> {
  const parts = await tx.select({
    technicianId: schema.commissionEntry.technicianId, name: schema.technician.displayName,
    weight: schema.commissionEntry.weight, amount: schema.commissionEntry.amount,
  }).from(schema.commissionEntry)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.commissionEntry.technicianId))
    .where(and(eq(schema.commissionEntry.eventId, event.id), eq(schema.commissionEntry.kind, "earned")))
    .orderBy(asc(schema.commissionEntry.shareIndex));
  return {
    eventId: event.id, total: event.total, occurredAt: event.occurredAt, splitNote: event.splitNote,
    standingNote: event.standingNote,
    explanation: event.explanation,
    itemRule: labor.readItemRateRule({ itemRule: event.itemRule }),
    lines: event.lines,
    parts: parts.map((p) => ({ technicianId: p.technicianId, name: p.name, weight: p.weight, amount: p.amount })),
  };
}

export interface SharedEarning {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  customerName: string;
  jobNumber: string;
  revenue: string;
  issuedAt: Date;
  people: { technicianId: string; name: string }[];
  /**
   * The split proposed, worked out as settling it would: the total and each
   * person's part, or the refusal settling would give (two plans in force and
   * none named, a margin plan with no cost). What "settle as proposed" pays.
   */
  proposed: {
    total: string | null;
    parts: { technicianId: string; name: string; amount: string }[];
    standingSentence: string | null;
    refusal: string | null;
  };
}

/**
 * EARNINGS SEVERAL PEOPLE SHARE, WAITING TO BE SETTLED, and the last ones
 * that were.
 *
 * Waiting: an invoice that has been sent or paid, not voided or written off,
 * on a job more than one person was assigned to, with no commission settled
 * yet. Only invoices made since the company declared its first commission
 * plan, because nothing told anybody an older one earned commission; one of
 * those can still be opened and settled by its own link. Newest first, fifty
 * at a time.
 *
 * Settled: the last twenty earnings paid to more than one person, with each
 * part and the reason the office gave when it changed the even split.
 */
export async function shared(ctx: ServiceContext): Promise<{
  waiting: SharedEarning[];
  settled: {
    invoiceId: string; invoiceNumber: string; total: string; occurredAt: Date; splitNote: string | null;
    standingNote: string | null;
    parts: { technicianId: string; name: string; weight: string | null; amount: string }[];
  }[];
}> {
  return guardedRead(ctx, "commission:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const waiting = await tx.execute<{
      id: string; number: number; number_prefix: string | null; status: string; revenue: string; created_at: Date;
      customer_name: string; job_id: string; job_number: number; job_prefix: string | null;
    }>(sql`
      select i.id, i.number, i.number_prefix, i.status::text as status,
             (i.subtotal - i.discount_total)::numeric(14,4)::text as revenue, i.created_at,
             c.name as customer_name, j.id as job_id, j.number as job_number, j.number_prefix as job_prefix
      from public.invoice i
      join public.job j on j.id = i.job_id
      join public.customer c on c.id = i.customer_id
      where i.organization_id = ${org}
        and i.deleted_at is null
        and i.status not in ('draft', 'void', 'written_off')
        and not exists (select 1 from public.commission_event ce where ce.invoice_id = i.id)
        and i.created_at >= (select min(cp.created_at) from public.commission_plan cp where cp.organization_id = ${org})
        and (
          select count(distinct va.technician_id) from public.visit_assignment va
          join public.visit v on v.id = va.visit_id where v.job_id = j.id and not v.from_history
        ) >= 2
      order by i.created_at desc
      limit 50
    `);
    const people = new Map<string, { technicianId: string; name: string }[]>();
    const proposed = new Map<string, SharedEarning["proposed"]>();
    for (const row of waiting) {
      if (!people.has(row.job_id)) people.set(row.job_id, await peopleOnJob(tx, row.job_id));
      proposed.set(row.id, await proposedFor(tx, ctx, row.id, row.job_id));
    }

    const events = await tx.execute<{ id: string }>(sql`
      select ce.id from public.commission_event ce
      where ce.organization_id = ${org}
        and (select count(*) from public.commission_entry e where e.event_id = ce.id and e.kind = 'earned') >= 2
      order by ce.occurred_at desc
      limit 20
    `);
    const settled = [];
    for (const { id } of events) {
      const [event] = await tx.select({ event: schema.commissionEvent, number: schema.invoice.number, prefix: schema.invoice.numberPrefix })
        .from(schema.commissionEvent)
        .innerJoin(schema.invoice, eq(schema.invoice.id, schema.commissionEvent.invoiceId))
        .where(eq(schema.commissionEvent.id, id)).limit(1);
      if (!event) continue;
      const split = await settledSplit(tx, event.event);
      settled.push({
        invoiceId: event.event.invoiceId, invoiceNumber: work.documentNumber(event.prefix, event.number),
        total: split.total, occurredAt: split.occurredAt, splitNote: split.splitNote, standingNote: split.standingNote, parts: split.parts,
      });
    }

    return {
      waiting: waiting.map((row) => ({
        invoiceId: row.id,
        invoiceNumber: work.documentNumber(row.number_prefix, row.number),
        status: row.status,
        customerName: row.customer_name,
        jobNumber: work.documentNumber(row.job_prefix, row.job_number),
        revenue: row.revenue,
        issuedAt: new Date(row.created_at),
        people: people.get(row.job_id) ?? [],
        proposed: proposed.get(row.id)!,
      })),
      settled,
    };
  });
}

/**
 * The proposed split for one waiting invoice, worked out through `prepare` as
 * settling it would be, or the refusal settling would give. Writes nothing.
 */
async function proposedFor(
  tx: Database, ctx: ServiceContext, invoiceId: string, jobId: string | null, planId?: string,
): Promise<SharedEarning["proposed"]> {
  const { onJob, split } = await proposedWithin(tx, ctx.actor.organizationId, jobId);
  const shares = split.shares.filter((s) => SHARE_IS_POSITIVE(s.weight)).map((s) => ({ technicianId: s.personId, weight: s.weight }));
  const names = new Map(onJob.map((p) => [p.technicianId, p.name]));
  try {
    const worked = await prepare(tx, ctx, { invoiceId, ...(planId ? { planId } : {}), shares });
    return {
      total: m.toString(worked.verdict.total),
      parts: worked.verdict.parts.map((part) => ({
        technicianId: part.personId, name: names.get(part.personId) ?? "Unknown", amount: m.toString(part.amount),
      })),
      standingSentence: split.sentence,
      refusal: null,
    };
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { total: null, parts: [], standingSentence: split.sentence, refusal: error.message };
    }
    throw error;
  }
}

export interface BatchOutcome {
  invoiceId: string;
  invoiceNumber: string | null;
  /** The earning, when it settled (or had already settled this way). */
  eventId: string | null;
  total: string | null;
  replayed: boolean;
  /** Why it was not settled, in the words settling it alone would have used. */
  refusal: string | null;
}

/**
 * SETTLE SEVERAL SHARED COMMISSIONS AT ONCE, EACH AS PROPOSED.
 *
 * For the invoices whose proposed split nobody changed: each is settled
 * exactly as "Settle this split" would settle it alone, through `settleSplit`
 * with the split proposed (even, or shaped by standing shares) and no reason,
 * in its own transaction, so it is audited as one earning (`commission.earned`,
 * with the proposal beside it) and one refusal does not hold up the rest. The
 * proposal is read first and checked again inside the settle, so a standing
 * share changed in between is refused for that invoice rather than settled
 * under a split nobody saw.
 *
 * Repeated, an invoice already settled with its proposed split answers with
 * that earning, as settling it alone again does; one settled another way is
 * refused for that invoice.
 */
export async function settleProposed(
  ctx: ServiceContext, input: { invoiceIds: readonly string[]; planId?: string | undefined },
): Promise<{ settled: BatchOutcome[]; refused: BatchOutcome[] }> {
  /**
   * Checked once before anything, not only by each settle: a list that turns
   * out empty, or whose every invoice is refused before settling, must still
   * be refused to somebody who may not settle commission at all.
   */
  assertCan(ctx.actor, "commission:configure");
  const ids = [...new Set(input.invoiceIds ?? [])];
  if (ids.length === 0) throw new ConflictError("Tick the invoices to settle as proposed.");
  const settled: BatchOutcome[] = [];
  const refused: BatchOutcome[] = [];
  for (const invoiceId of ids) {
    /** What was proposed, read by somebody who may settle it, before settling it. */
    const seen = await guardedRead(ctx, "commission:configure", async (tx) => {
      const [invoice] = await tx.select({ id: schema.invoice.id, jobId: schema.invoice.jobId, number: schema.invoice.number, prefix: schema.invoice.numberPrefix })
        .from(schema.invoice)
        .where(and(eq(schema.invoice.organizationId, ctx.actor.organizationId), eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt)))
        .limit(1);
      if (!invoice) return null;
      const { split } = await proposedWithin(tx, ctx.actor.organizationId, invoice.jobId);
      return { number: work.documentNumber(invoice.prefix, invoice.number), shares: split.shares };
    });
    if (!seen) {
      refused.push({ invoiceId, invoiceNumber: null, eventId: null, total: null, replayed: false, refusal: "No such invoice." });
      continue;
    }
    if (seen.shares.length === 0) {
      refused.push({
        invoiceId, invoiceNumber: seen.number, eventId: null, total: null, replayed: false,
        refusal: "Nobody is on this job's visits, so there is no split to propose. Open it and name who it is for.",
      });
      continue;
    }
    try {
      const done = await settleSplit(ctx, {
        invoiceId,
        ...(input.planId ? { planId: input.planId } : {}),
        shares: seen.shares.map((s) => ({ technicianId: s.personId, weight: s.weight })),
      });
      settled.push({ invoiceId, invoiceNumber: seen.number, eventId: done.id, total: done.total, replayed: done.replayed, refusal: null });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof UnprocessableError) {
        const said = error instanceof UnprocessableError ? error.issues[0]?.message ?? error.message : error.message;
        refused.push({ invoiceId, invoiceNumber: seen.number, eventId: null, total: null, replayed: false, refusal: said });
        continue;
      }
      throw error;
    }
  }
  return { settled, refused };
}

/**
 * SETTLE A SHARED COMMISSION FROM THE SPLIT SCREEN.
 *
 * The same settling as `settle`, under `commission:configure`, with one more
 * rule: a split that is not the even one proposed between the people on the
 * job needs a reason, because the person paid less than an even share is
 * owed an answer, and it is written on the earning and into each part's
 * explanation, which is what they read on their statement. The audit records
 * the split proposed beside the one settled.
 *
 * Sent again with the same split, it answers with what was settled; a
 * different split for an invoice that has already earned is refused, as
 * settling twice always is.
 */
export async function settleSplit(
  ctx: ServiceContext,
  input: { invoiceId: string; planId?: string | undefined; shares: readonly ShareInput[]; reason?: string | undefined },
) {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    const [invoice] = await tx.select({ id: schema.invoice.id, jobId: schema.invoice.jobId }).from(schema.invoice)
      .where(and(eq(schema.invoice.organizationId, ctx.actor.organizationId), eq(schema.invoice.id, input.invoiceId), isNull(schema.invoice.deletedAt)))
      .limit(1);
    if (!invoice) throw new NotFoundError("Invoice");

    /** A person at zero is not paid: they are left out rather than given a part of nothing. */
    const shares = input.shares.filter((s) => SHARE_IS_POSITIVE(s.weight));
    const checked = labor.checkShares(input.shares.map((s) => ({ personId: s.technicianId, weight: s.weight })));
    if (!checked.ok) throw new UnprocessableError("That split cannot be settled", [{ path: "shares", message: checked.reason }]);

    const [existing] = await tx.select().from(schema.commissionEvent)
      .where(and(eq(schema.commissionEvent.organizationId, ctx.actor.organizationId), eq(schema.commissionEvent.invoiceId, invoice.id)))
      .limit(1);
    if (existing) {
      const split = await settledSplit(tx, existing);
      const same = labor.sameSplit(
        split.parts.map((p) => ({ personId: p.technicianId, weight: p.weight ?? "1" })),
        shares.map((s) => ({ personId: s.technicianId, weight: s.weight })),
      );
      if (same) {
        return { id: existing.id, invoiceId: invoice.id, total: existing.total, splitNote: existing.splitNote, replayed: true as const };
      }
      throw new ConflictError("That invoice has already earned its commission, shared another way. Settling it again would pay it twice.");
    }

    const { split } = await proposedWithin(tx, ctx.actor.organizationId, invoice.jobId);
    const proposed = split.shares;
    const changed = !labor.sameSplit(proposed, shares.map((s) => ({ personId: s.technicianId, weight: s.weight })));
    const reason = input.reason?.trim() ?? "";
    if (changed && reason === "") {
      throw new UnprocessableError("A reason for the split", [{
        path: "reason",
        message: split.applied.length > 0
          ? "This is not the split the standing shares propose. Say why, in a sentence the people paid will read."
          : "This is not an even split between the people on the job. Say why, in a sentence the people paid will read.",
      }]);
    }
    const done = await settleIn(tx, ctx, {
      invoiceId: invoice.id,
      ...(input.planId ? { planId: input.planId } : {}),
      shares,
      proposed,
      ...(changed ? { splitNote: reason } : split.sentence ? { standingNote: split.sentence } : {}),
    });
    return { id: done.id, invoiceId: invoice.id, total: done.total, splitNote: changed ? reason : null, replayed: false as const };
  });
}

/* ---------------------------------------- settling by itself when paid */

/**
 * SETTLE A COMMISSION BY ITSELF WHEN ITS INVOICE IS PAID IN FULL.
 *
 * A company setting, off until somebody with `commission:configure` turns it
 * on, kept beside the item rule in `organization.settings.commission`. When
 * it is on, the worker reads each `invoice.paid` in the company's log (paid
 * in full is the event; a part payment is not) and settles the invoice's
 * commission through `settleSplit` with the split proposed, which is exactly
 * what "Settle the ticked ones as proposed" does for one invoice: the same
 * parts, the same standing shares, the same ledger posting, and the same
 * `commission.earned` audit with the proposal beside it, made by the system
 * (no user, `actor_agent_id` "commission-on-payment").
 *
 * ONLY WHEN NOTHING IS LEFT TO DECIDE. `labor.onPaymentDecision` says when:
 * the one plan in force pays on what was collected, and the split is the one
 * a person would settle without a reason. Otherwise, and whenever settling
 * refuses, the invoice is left for a person and listed on the commission
 * screen with why, in the words settling used.
 *
 * NEVER TWICE. An invoice with an earning is passed over, whoever made it,
 * and the earning's unique index is the guard underneath. A refund or a void
 * afterwards is what it is for an earning a person made: nothing reverses by
 * itself, and `POST /v1/commissions/reversals` takes it back. Paid in full
 * again later, it already has its earning and is passed over.
 *
 * FROM THEN ON. Only invoices paid in full after it was turned on: turning
 * it on is not a way to settle last year's invoices in one go.
 */
const ON_PAYMENT_CONSUMER = "commission-on-payment";

/** What the worker acts as here: it settles commission and reads what that needs, nothing else. */
function onPaymentActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["commission:read", "commission:configure"],
    agentId: ON_PAYMENT_CONSUMER,
  };
}

interface OnPaymentSetting { on: boolean; since: Date | null }

async function onPaymentWithin(tx: Database, organizationId: string): Promise<OnPaymentSetting> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const commission = ((row?.settings ?? {}) as Record<string, unknown>)["commission"];
  const value = commission && typeof commission === "object" ? commission as Record<string, unknown> : {};
  const since = typeof value["settleOnPaymentSince"] === "string" ? new Date(value["settleOnPaymentSince"]) : null;
  /** A hand edited blob that says on without a start reads as off: there is no "from then on" to go by. */
  const on = value["settleOnPayment"] === true && since !== null && !Number.isNaN(since.getTime());
  return { on, since: on ? since : null };
}

export interface OnPaymentView {
  on: boolean;
  /** When it was turned on. Only invoices paid in full from then are settled by it. */
  since: Date | null;
  /** The plans in force that earn on payment. With none, turning it on settles nothing, and the screen says so. */
  earnsOnPayment: { id: string; label: string }[];
  /** Invoices it left for a person, still without a commission, with why. */
  left: { invoiceId: string; invoiceNumber: string; customerName: string; reason: string; at: Date }[];
  /** The last ones it settled. */
  settled: { invoiceId: string; invoiceNumber: string; customerName: string; total: string; at: Date }[];
}

/** The setting, and what it has done lately. `commission:read`. */
export async function onPayment(ctx: ServiceContext): Promise<OnPaymentView> {
  return guardedRead(ctx, "commission:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const setting = await onPaymentWithin(tx, org);
    const plans = await tx.select({ id: schema.commissionPlan.id, label: schema.commissionPlan.label, basis: schema.commissionPlan.basis })
      .from(schema.commissionPlan)
      .where(and(eq(schema.commissionPlan.organizationId, org), eq(schema.commissionPlan.active, true)))
      .orderBy(asc(schema.commissionPlan.label));
    const rows = (outcome: "settled" | "left", limit: number) => tx.select({
      row: schema.commissionOnPayment,
      number: schema.invoice.number, prefix: schema.invoice.numberPrefix, customerName: schema.customer.name,
      total: schema.commissionEvent.total,
    }).from(schema.commissionOnPayment)
      .innerJoin(schema.invoice, eq(schema.invoice.id, schema.commissionOnPayment.invoiceId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
      .leftJoin(schema.commissionEvent, and(
        eq(schema.commissionEvent.organizationId, org),
        eq(schema.commissionEvent.invoiceId, schema.commissionOnPayment.invoiceId),
      ))
      .where(and(
        eq(schema.commissionOnPayment.organizationId, org),
        eq(schema.commissionOnPayment.outcome, outcome),
        /**
         * Left: still without an earning (a person settling it takes it off the
         * list) and still owed for, since a void or write off means there is
         * nothing to earn on.
         */
        ...(outcome === "left" ? [
          isNull(schema.commissionEvent.id),
          isNull(schema.invoice.deletedAt),
          sql`${schema.invoice.status} not in ('void', 'written_off')`,
        ] : []),
      ))
      .orderBy(sql`${schema.commissionOnPayment.updatedAt} desc`)
      .limit(limit);
    const [left, settled] = [await rows("left", 50), await rows("settled", 20)];
    return {
      on: setting.on,
      since: setting.since,
      earnsOnPayment: plans.filter((p) => labor.EARNS_ON_PAYMENT.includes(p.basis)).map((p) => ({ id: p.id, label: p.label })),
      left: left.map((r) => ({
        invoiceId: r.row.invoiceId, invoiceNumber: work.documentNumber(r.prefix, r.number), customerName: r.customerName,
        reason: r.row.reason ?? "", at: r.row.updatedAt,
      })),
      settled: settled.map((r) => ({
        invoiceId: r.row.invoiceId, invoiceNumber: work.documentNumber(r.prefix, r.number), customerName: r.customerName,
        total: r.total ?? "0", at: r.row.updatedAt,
      })),
    };
  });
}

/**
 * Turn it on or off. `commission:configure`, as the item rule is: it decides
 * when people are paid. The same answer again changes nothing and is not
 * audited twice; turning it on again starts a new "from then on".
 */
export async function setOnPayment(ctx: ServiceContext, input: { on: boolean }): Promise<OnPaymentView> {
  await guardedWrite(ctx, "commission:configure", async (tx) => {
    const before = await onPaymentWithin(tx, ctx.actor.organizationId);
    if (before.on === input.on) return;
    const since = input.on ? new Date().toISOString() : null;
    await mergeCommissionSettings(tx, ctx.actor.organizationId, { settleOnPayment: input.on, settleOnPaymentSince: since });
    await audit(tx, ctx, "commission_on_payment.set", "organization", ctx.actor.organizationId,
      { settleOnPayment: before.on, since: before.since?.toISOString() ?? null },
      { settleOnPayment: input.on, since });
  });
  return onPayment(ctx);
}

export type OnPaymentOutcome =
  | { outcome: "settled"; eventId: string }
  | { outcome: "left"; reason: string }
  /** Nothing to do: not paid now, already earned, or no plan in force earns on payment. */
  | { outcome: "none" };

/**
 * One invoice paid in full, settled or left. In one transaction with the
 * record of what was done, so the screen never shows an earning nobody can
 * account for or a refusal for something that settled.
 */
async function settlePaid(ctx: ServiceContext, invoiceId: string, sequence: number): Promise<OnPaymentOutcome> {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    const org = ctx.actor.organizationId;
    /** One worker at a time per invoice, so two passes cannot both decide it. */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`commission-on-payment:${org}:${invoiceId}`}))`);
    const [invoice] = await tx.select({ id: schema.invoice.id, status: schema.invoice.status, jobId: schema.invoice.jobId })
      .from(schema.invoice)
      .where(and(eq(schema.invoice.organizationId, org), eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt)))
      .limit(1);
    /**
     * Paid and then refunded or voided before the worker came round: it is
     * not paid in full now, and paying it again raises the event again.
     */
    if (!invoice || invoice.status !== "paid") return { outcome: "none" };
    const [earned] = await tx.select({ id: schema.commissionEvent.id }).from(schema.commissionEvent)
      .where(and(eq(schema.commissionEvent.organizationId, org), eq(schema.commissionEvent.invoiceId, invoiceId)))
      .limit(1);
    if (earned) return { outcome: "none" };

    const plans = await tx.select({ label: schema.commissionPlan.label, basis: schema.commissionPlan.basis })
      .from(schema.commissionPlan)
      .where(and(eq(schema.commissionPlan.organizationId, org), eq(schema.commissionPlan.active, true)))
      .orderBy(asc(schema.commissionPlan.label));
    const { onJob, split } = await proposedWithin(tx, org, invoice.jobId);
    const decided = labor.onPaymentDecision({ plans, onJob: invoice.jobId !== null, people: onJob.length, conflict: split.conflict });
    if (decided.act === "skip") return { outcome: "none" };

    const record = async (outcome: OnPaymentOutcome & { outcome: "settled" | "left" }) => {
      const [row] = await tx.insert(schema.commissionOnPayment).values({
        organizationId: org, invoiceId, outcome: outcome.outcome,
        reason: outcome.outcome === "left" ? outcome.reason : null,
        commissionEventId: outcome.outcome === "settled" ? outcome.eventId : null,
        eventSequence: sequence,
      }).onConflictDoUpdate({
        target: [schema.commissionOnPayment.organizationId, schema.commissionOnPayment.invoiceId],
        set: {
          outcome: outcome.outcome,
          reason: outcome.outcome === "left" ? outcome.reason : null,
          commissionEventId: outcome.outcome === "settled" ? outcome.eventId : null,
          eventSequence: sequence,
          updatedAt: new Date(),
        },
      }).returning({ id: schema.commissionOnPayment.id });
      await audit(tx, ctx, `commission_on_payment.${outcome.outcome}`, "commission_on_payment", row!.id, null, {
        invoiceId, eventSequence: sequence,
        ...(outcome.outcome === "left" ? { reason: outcome.reason } : { commissionEventId: outcome.eventId }),
      });
      return outcome;
    };

    if (decided.act === "leave") return record({ outcome: "left", reason: decided.reason });
    try {
      /** The settling a person's "Settle the ticked ones as proposed" uses, inside this transaction. */
      const done = await settleSplit({ ...ctx, db: tx }, {
        invoiceId, shares: split.shares.map((s) => ({ technicianId: s.personId, weight: s.weight })),
      });
      return record({ outcome: "settled", eventId: done.id });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof UnprocessableError) {
        const said = error instanceof UnprocessableError ? error.issues[0]?.message ?? error.message : error.message;
        return record({ outcome: "left", reason: said });
      }
      throw error;
    }
  });
}

export interface OnPaymentPassResult {
  organizationId: string;
  settled: { invoiceId: string; eventId: string }[];
  left: { invoiceId: string; reason: string }[];
}

/**
 * THE WORKER'S PASS FOR ONE COMPANY, after each drain that found its events.
 *
 * Its own place in the company's log (`event_cursor`, consumer
 * "commission-on-payment"), moved forward past each event it has dealt with,
 * so a pass cut short picks up where it stopped and nothing is read twice in
 * the ordinary course. Read twice anyway (two workers), the second finds the
 * earning and does nothing. While the setting is off the place still moves,
 * so turning it on never reaches back to invoices paid before.
 */
export async function settleOnPaymentFor(
  db: Database, organizationId: string, options: { limit?: number } = {},
): Promise<OnPaymentPassResult> {
  const ctx: ServiceContext = { actor: onPaymentActor(organizationId), db };
  const limit = options.limit ?? 50;
  const result: OnPaymentPassResult = { organizationId, settled: [], left: [] };

  const advance = (to: number) => inTenant(ctx, async (tx) => {
    await tx.insert(schema.eventCursor)
      .values({ organizationId, consumer: ON_PAYMENT_CONSUMER, lastSequence: to, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.eventCursor.organizationId, schema.eventCursor.consumer],
        set: { lastSequence: sql`greatest(${schema.eventCursor.lastSequence}, excluded.last_sequence)`, updatedAt: new Date() },
      });
  });

  const read = await inTenant(ctx, async (tx) => {
    const setting = await onPaymentWithin(tx, organizationId);
    const [cursor] = await tx.select({ last: schema.eventCursor.lastSequence }).from(schema.eventCursor)
      .where(and(eq(schema.eventCursor.organizationId, organizationId), eq(schema.eventCursor.consumer, ON_PAYMENT_CONSUMER)))
      .limit(1);
    const [top] = await tx.select({ last: sql<number | null>`max(${schema.domainEvent.sequence})` }).from(schema.domainEvent)
      .where(eq(schema.domainEvent.organizationId, organizationId));
    const after = cursor?.last ?? 0;
    const upTo = Number(top?.last ?? 0);
    if (!setting.on || !setting.since || upTo <= after) return { upTo, events: [] };
    const events = await tx.select({ sequence: schema.domainEvent.sequence, invoiceId: schema.domainEvent.entityId })
      .from(schema.domainEvent)
      .where(and(
        eq(schema.domainEvent.organizationId, organizationId),
        eq(schema.domainEvent.name, "invoice.paid"),
        gt(schema.domainEvent.sequence, after),
        lte(schema.domainEvent.sequence, upTo),
        gte(schema.domainEvent.occurredAt, setting.since),
      ))
      .orderBy(asc(schema.domainEvent.sequence))
      .limit(limit);
    return { upTo, events };
  });

  for (const event of read.events) {
    if (event.invoiceId) {
      const outcome = await settlePaid(ctx, event.invoiceId, event.sequence);
      if (outcome.outcome === "settled") result.settled.push({ invoiceId: event.invoiceId, eventId: outcome.eventId });
      if (outcome.outcome === "left") result.left.push({ invoiceId: event.invoiceId, reason: outcome.reason });
    }
    await advance(event.sequence);
  }
  /** A full page may have more behind it; anything short of one read to the end. */
  if (read.events.length < limit) await advance(read.upTo);
  return result;
}

/* ----------------------------------------------------- standing shares */

export interface StandingShareView {
  id: string;
  technicianId: string;
  name: string;
  percent: number;
  applies: "always" | "as_lead";
  /** "Ray takes 30% of shared commission whenever they are on the job." */
  inWords: string;
  reason: string;
  setAt: Date;
  endedAt: Date | null;
}

const standingView = (row: {
  id: string; technicianId: string; name: string; percent: number; applies: "always" | "as_lead";
  reason: string; createdAt: Date; endedAt: Date | null;
}): StandingShareView => ({
  id: row.id, technicianId: row.technicianId, name: row.name, percent: row.percent, applies: row.applies,
  inWords: `${row.name} takes ${row.percent}% of shared commission ${labor.STANDING_APPLIES[row.applies]}.`,
  reason: row.reason, setAt: row.createdAt, endedAt: row.endedAt,
});

async function standingRows(tx: Database, organizationId: string, where: "live" | "ended" | { id: string }, limit = 100) {
  const rows = await tx.select({
    id: schema.commissionStandingShare.id,
    technicianId: schema.commissionStandingShare.technicianId,
    name: schema.technician.displayName,
    percent: schema.commissionStandingShare.percent,
    applies: schema.commissionStandingShare.applies,
    reason: schema.commissionStandingShare.reason,
    createdAt: schema.commissionStandingShare.createdAt,
    endedAt: schema.commissionStandingShare.endedAt,
  }).from(schema.commissionStandingShare)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.commissionStandingShare.technicianId))
    .where(and(
      eq(schema.commissionStandingShare.organizationId, organizationId),
      typeof where === "object"
        ? eq(schema.commissionStandingShare.id, where.id)
        : where === "live" ? isNull(schema.commissionStandingShare.endedAt) : sql`${schema.commissionStandingShare.endedAt} is not null`,
    ))
    .orderBy(where === "live" ? asc(schema.technician.displayName) : sql`${schema.commissionStandingShare.endedAt} desc`)
    .limit(limit);
  return rows.map(standingView);
}

/**
 * THE STANDING SHARES IN FORCE, and the last ones stopped. `commission:read`:
 * anybody who can see a proposed split can see what shaped it.
 */
export async function standingShares(ctx: ServiceContext): Promise<{
  live: StandingShareView[]; ended: StandingShareView[]; people: { technicianId: string; name: string }[];
}> {
  return guardedRead(ctx, "commission:read", async (tx) => ({
    live: await standingRows(tx, ctx.actor.organizationId, "live"),
    ended: await standingRows(tx, ctx.actor.organizationId, "ended", 20),
    /** Everybody who can be given one, for the form. */
    people: await tx.select({ technicianId: schema.technician.id, name: schema.technician.displayName })
      .from(schema.technician)
      .where(eq(schema.technician.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.technician.displayName)),
  }));
}

/**
 * GIVE SOMEBODY A STANDING SHARE OF THE COMMISSIONS THEY SHARE.
 *
 * `commission:configure`, as declaring a plan is: it decides who is owed what
 * on every shared commission from now on. A share already in force for the
 * same person is stopped, never edited, so what was proposed last month can
 * still be explained. Sent again with what is already in force, it answers
 * with that rather than writing a second row. Earnings already settled are
 * not touched: they keep the split they were settled with.
 */
export async function setStandingShare(ctx: ServiceContext, input: {
  technicianId: string; percent: number; applies: "always" | "as_lead"; reason: string;
}): Promise<StandingShareView & { replayed: boolean }> {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    const org = ctx.actor.organizationId;
    const checked = labor.checkStandingShare(input);
    if (!checked.ok) throw new UnprocessableError("That standing share cannot be set", [{ path: "percent", message: checked.reason }]);
    const [person] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .where(and(eq(schema.technician.organizationId, org), eq(schema.technician.id, input.technicianId))).limit(1);
    if (!person) throw new NotFoundError("Technician");

    /** One writer at a time per person, so two offices setting a share at once cannot both stop the old one. */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`standing-share:${org}:${input.technicianId}`}))`);
    const [live] = await tx.select().from(schema.commissionStandingShare)
      .where(and(
        eq(schema.commissionStandingShare.organizationId, org),
        eq(schema.commissionStandingShare.technicianId, input.technicianId),
        isNull(schema.commissionStandingShare.endedAt),
      )).limit(1);
    const reason = input.reason.trim();
    const viewOf = async (id: string) => (await standingRows(tx, org, { id }))[0]!;
    if (live && live.percent === input.percent && live.applies === input.applies && live.reason === reason) {
      return { ...(await viewOf(live.id)), replayed: true };
    }
    const now = new Date();
    if (live) {
      await tx.update(schema.commissionStandingShare)
        .set({ endedAt: now, endedByUserId: ctx.actor.userId, updatedAt: now })
        .where(eq(schema.commissionStandingShare.id, live.id));
    }
    const [row] = await refusingDuplicate(
      "commission_standing_share_live_idx",
      "This person already has a standing share in force. Stop it, or set the new one again.",
      () => tx.insert(schema.commissionStandingShare).values({
        organizationId: org, technicianId: input.technicianId, percent: input.percent,
        applies: input.applies, reason, setByUserId: ctx.actor.userId,
      }).returning(),
    );
    await audit(tx, ctx, "commission.standing_share_set", "commission_standing_share", row!.id, live ?? null, row);
    return { ...(await viewOf(row!.id)), replayed: false };
  });
}

/** STOP A STANDING SHARE. Proposals from now on leave it out; settled earnings keep what they were settled with. */
export async function endStandingShare(ctx: ServiceContext, input: { id: string }): Promise<StandingShareView> {
  return guardedWrite(ctx, "commission:configure", async (tx) => {
    const org = ctx.actor.organizationId;
    const [row] = await tx.select().from(schema.commissionStandingShare)
      .where(and(eq(schema.commissionStandingShare.organizationId, org), eq(schema.commissionStandingShare.id, input.id))).limit(1);
    if (!row) throw new NotFoundError("Standing share");
    if (row.endedAt === null) {
      const now = new Date();
      const [ended] = await tx.update(schema.commissionStandingShare)
        .set({ endedAt: now, endedByUserId: ctx.actor.userId, updatedAt: now })
        .where(eq(schema.commissionStandingShare.id, row.id)).returning();
      await audit(tx, ctx, "commission.standing_share_ended", "commission_standing_share", row.id, row, ended);
    }
    return (await standingRows(tx, org, { id: row.id }))[0]!;
  });
}

/** A weight above zero, read exactly. */
const SHARE_IS_POSITIVE = (weight: string) => labor.SHARE_WEIGHT.test(weight) && /[1-9]/.test(weight);

/* ------------------------------------------------------------- internals */

async function resolvePlan(
  tx: Database, ctx: ServiceContext, planId: string | undefined,
): Promise<typeof schema.commissionPlan.$inferSelect> {
  if (planId) {
    const [named] = await tx.select().from(schema.commissionPlan)
      .where(and(
        eq(schema.commissionPlan.id, planId),
        eq(schema.commissionPlan.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!named) throw new NotFoundError("Commission plan");
    /**
     * A deactivated plan can still be named. A company settling an invoice
     * they forgot about last quarter has to be able to settle it under the
     * plan that was in force then, and refusing would leave them editing the
     * database or paying under today's plan, which is worse.
     */
    return named;
  }

  const active = await tx.select().from(schema.commissionPlan)
    .where(and(
      eq(schema.commissionPlan.organizationId, ctx.actor.organizationId),
      eq(schema.commissionPlan.active, true),
    ))
    .orderBy(asc(schema.commissionPlan.label));

  if (active.length === 0) {
    throw new ConflictError(
      "No commission plan is declared for this company, so there is nothing to settle this under. "
      + "Declare one first: there is no default, because every basis rewards something different "
      + "and the choice is the instruction your technicians will follow.",
    );
  }
  if (active.length > 1) {
    /**
     * Refused rather than picking the first. Two active plans is a normal
     * thing for a company to have, one for installers and one for service, and
     * guessing which governs an invoice pays somebody under the wrong one and
     * nothing on the screen says so.
     */
    throw new ConflictError(
      `${active.length} commission plans are active (${active.map((p) => p.label).join(", ")}). `
      + "Name which one this invoice is under.",
    );
  }
  return active[0]!;
}

/**
 * Who it is split between.
 *
 * The evenly split default is a convenience and is named as one in the
 * explanation core writes onto each part, so a technician reading their
 * statement can see that nobody declared the split. What it will not do is
 * guess a sole earner: the person who sold the job and the person who did it
 * are routinely different, and picking one of them quietly is how a product
 * pays the wrong person for a year.
 */
async function resolveShares(
  tx: Database, ctx: ServiceContext, jobId: string | null,
  given: readonly ShareInput[] | undefined,
): Promise<{ shares: ShareInput[]; standingNote: string | null }> {
  let shares: ShareInput[];
  let standingNote: string | null = null;

  if (given && given.length > 0) {
    shares = given.map((share) => ({ technicianId: share.technicianId, weight: share.weight }));
  } else {
    if (!jobId) {
      throw new ConflictError(
        "This invoice is not against a job, so there is nobody to infer a split from. "
        + "Name who the commission is for.",
      );
    }
    const assigned = await tx.select({
      technicianId: schema.visitAssignment.technicianId,
      isLead: sql<boolean>`bool_or(${schema.visitAssignment.isLead})`,
    })
      .from(schema.visitAssignment)
      .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
      .where(and(eq(schema.visit.jobId, jobId), eq(schema.visit.fromHistory, false)))
      .groupBy(schema.visitAssignment.technicianId)
      .orderBy(asc(schema.visitAssignment.technicianId));
    if (assigned.length === 0) {
      throw new ConflictError(
        "Nobody is assigned to that job's visits, so there is nobody to pay the commission to. "
        + "Name the split.",
      );
    }
    /**
     * The split the screen would propose: even, or shaped by the standing
     * shares of the people on the job, so settling without naming a split pays
     * what the company declared rather than a split nobody chose.
     */
    const proposed = labor.proposeSplit(
      assigned.map((row) => ({ personId: row.technicianId, isLead: row.isLead })),
      await standingFor(tx, ctx.actor.organizationId, assigned.map((row) => row.technicianId)),
    );
    shares = proposed.shares.map((share) => ({ technicianId: share.personId, weight: share.weight }));
    standingNote = proposed.sentence;
  }

  /**
   * The rule is core's (`labor.checkShares`), so this and the split screen
   * refuse the same splits in the same words: a person named twice, a weight
   * that is not a decimal, and a split of zeros, which `money.allocate` would
   * otherwise throw on as a server error.
   */
  const checked = labor.checkShares(shares.map((share) => ({ personId: share.technicianId, weight: share.weight })));
  if (!checked.ok) throw new ConflictError(checked.reason);

  const ids = shares.map((share) => share.technicianId);
  const known = await tx.select({ id: schema.technician.id }).from(schema.technician)
    .where(and(
      eq(schema.technician.organizationId, ctx.actor.organizationId),
      inArray(schema.technician.id, ids),
    ));
  if (known.length !== ids.length) {
    throw new NotFoundError("Technician in that split");
  }

  return { shares, standingNote };
}

/**
 * WHAT THE JOB COST, from the facts already in the database.
 *
 * Material from `job_line`, which exists for exactly this and carries
 * `unit_cost` under a comment saying so, and labour from the rate frozen onto
 * each punch. The LOADED rate here, base plus fringe, because this is what the
 * work cost the company. That is the mirror of the payroll export, which pays
 * at the BASE rate: the fringe is a contribution to a fund rather than wages,
 * and paying it as wages would hand a technician their own pension money.
 *
 * NULL RATHER THAN A SMALLER NUMBER whenever anything is unknown, and this is
 * the whole point of the function. A partial cost makes a job look more
 * profitable than it was, a margin commission computed from it overpays, and
 * nothing about the number says it is incomplete. Core refuses a margin plan
 * with no cost rather than treating it as zero, and this returns null so that
 * refusal can happen.
 *
 * WHEN A JOB COST ROLL-UP EXISTS, this should read it instead. It does not
 * depend on one and nothing here forbids one: it reads the two tables that
 * carry the facts today, and a roll-up would be a better source for the same
 * question.
 */
export async function costOf(tx: Database, jobId: string): Promise<m.Money | null> {
  const lines = await tx.select({
    quantity: schema.jobLine.quantity,
    unitCost: schema.jobLine.unitCost,
  }).from(schema.jobLine).where(eq(schema.jobLine.jobId, jobId));

  if (lines.some((line) => line.unitCost === null)) return null;

  const entries = await tx.select({
    minutes: schema.timeclockEntry.minutes,
    endedAt: schema.timeclockEntry.endedAt,
    loaded: schema.timeclockEntry.appliedLoadedRate,
  }).from(schema.timeclockEntry).where(eq(schema.timeclockEntry.jobId, jobId));

  /**
   * A punch still running is an unknown number of hours. Treating it as the
   * minutes recorded so far, which is none, understates the cost of the job by
   * however long the technician is still standing there.
   */
  if (entries.some((entry) => entry.endedAt === null)) return null;
  if (entries.some((entry) => entry.loaded === null)) return null;

  /**
   * Nothing recorded at all is not a cost of zero. A job with no lines and no
   * punches is one nobody has costed, and zero would make it infinitely
   * profitable under a margin plan.
   */
  if (lines.length === 0 && entries.length === 0) return null;

  let total = m.zero("USD");
  for (const line of lines) {
    total = m.add(total, m.multiply(usd(line.unitCost!), line.quantity));
  }
  for (const entry of entries) {
    total = m.add(total, labor.payFor(usd(entry.loaded!), (entry.minutes ?? 0) * 60));
  }
  return m.round(total, 2);
}

/**
 * The plan a stored event was computed under, reassembled from the FROZEN
 * columns rather than from the plan row.
 *
 * The plan may have been edited by being superseded, or deleted outright, and
 * a reversal recomputed under today's plan would take back an amount that was
 * never paid. The note is the one field that is not frozen, because core only
 * uses it to refuse a plan that has none; the event's own explanation stands
 * in when the plan row has gone.
 */
async function planBehind(
  tx: Database, event: typeof schema.commissionEvent.$inferSelect,
): Promise<labor.CommissionPlan> {
  const [row] = event.planId
    ? await tx.select({ note: schema.commissionPlan.note }).from(schema.commissionPlan)
      .where(eq(schema.commissionPlan.id, event.planId)).limit(1)
    : [];
  return {
    basis: event.basis,
    ...(event.appliedRate ? { rate: event.appliedRate } : {}),
    ...(event.appliedFlatAmount ? { flatAmount: usd(event.appliedFlatAmount) } : {}),
    note: row?.note ?? event.explanation,
    /** The company's choice as it was then, not as it is now: see `itemRule`. */
    itemRule: labor.readItemRateRule({ itemRule: event.itemRule }),
  };
}

const toCorePlan = (row: typeof schema.commissionPlan.$inferSelect): labor.CommissionPlan => ({
  basis: row.basis,
  ...(row.rate ? { rate: row.rate } : {}),
  ...(row.flatAmount ? { flatAmount: usd(row.flatAmount) } : {}),
  note: row.note,
});

/** The commission payable balance as the ledger holds it. Debits positive. */
export async function payableBalance(tx: Database, organizationId: string): Promise<m.Money> {
  const rows = await tx.execute<{ net: string }>(sql`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry
    where organization_id = ${organizationId} and account_code = ${ledger.ACCOUNTS.COMMISSION_PAYABLE}`);
  /** Negated so a credit balance, which is what a liability carries, reads positive. */
  return m.subtract(m.zero("USD"), usd(rows[0]?.net ?? "0"));
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listCommissionBases: async (ctx: ServiceContext): Promise<{
    bases: { key: string; label: string; meaning: string; wrongAbout: string; needs: string }[];
  }> => ({ bases: await bases(ctx) }),

  listCommissionPlans: async (ctx: ServiceContext): Promise<{
    plans: {
      id: string; label: string; basis: string; rate: string | null;
      flatAmount: string | null; note: string; active: boolean; wrongAbout: string;
    }[];
  }> => ({ plans: await plans(ctx) }),

  /**
   * `basis` IS A PLAIN STRING HERE, not core's union, and that is deliberate.
   *
   * Two reasons. It arrives as JSON from outside, so it is a string until
   * something checks it, and `declarePlan` checks it on its first line against
   * the same catalogue this list is built from: a value outside the union is
   * refused with a sentence naming the ones that exist, which is a better
   * answer than a type error nobody at the other end can see.
   *
   * The second is that a handler signature ends up in the inferred type of the
   * whole route registry, and naming another package's internal type there is
   * what makes that type unwritable from outside. It is not load bearing for
   * the build today, because this package emits no declarations and its
   * tsconfig says why, but it is the habit that keeps the registry portable if
   * it ever does.
   */
  declareCommissionPlan: (ctx: ServiceContext, input: {
    label: string; basis: string;
    rate?: string | undefined; flatAmount?: string | undefined; note: string;
  }) => declarePlan(ctx, {
    label: input.label, basis: input.basis as labor.CommissionBasisKey, note: input.note,
    ...(input.rate ? { rate: input.rate } : {}),
    ...(input.flatAmount ? { flatAmount: input.flatAmount } : {}),
  }),

  deactivateCommissionPlan: (ctx: ServiceContext, input: { id: string }) =>
    deactivatePlan(ctx, input),

  settleCommission: (ctx: ServiceContext, input: {
    invoiceId: string;
    planId?: string | undefined;
    shares?: readonly { technicianId: string; weight: string }[] | undefined;
    occurredAt?: string | undefined;
  }) => settle(ctx, {
    invoiceId: input.invoiceId,
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.shares ? { shares: input.shares } : {}),
    ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
  }),

  reverseCommission: (ctx: ServiceContext, input: {
    invoiceId: string; reason: labor.CreditReason; creditedRevenue: string;
    creditedCost?: string | undefined; causeType: string; causeId: string;
  }) => reverse(ctx, {
    invoiceId: input.invoiceId,
    reason: input.reason,
    creditedRevenue: input.creditedRevenue,
    causeType: input.causeType,
    causeId: input.causeId,
    ...(input.creditedCost ? { creditedCost: input.creditedCost } : {}),
  }),

  getCommissionSplit: (ctx: ServiceContext, input: {
    invoiceId: string; planId?: string | undefined; shares?: string | undefined;
  }) => proposal(ctx, {
    invoiceId: input.invoiceId,
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.shares ? { shares: parseShares(input.shares) } : {}),
  }),

  listSharedCommissions: (ctx: ServiceContext) => shared(ctx),

  getCommissionItemRule: (ctx: ServiceContext) => itemRule(ctx),

  /** `rule` is a plain string from outside, checked against core's list on the way in. See `declareCommissionPlan`. */
  setCommissionItemRule: (ctx: ServiceContext, input: { rule: string }) =>
    setItemRule(ctx, { rule: input.rule as labor.ItemRateRule }),

  getCommissionOnPayment: (ctx: ServiceContext) => onPayment(ctx),

  setCommissionOnPayment: (ctx: ServiceContext, input: { on: boolean }) => setOnPayment(ctx, input),

  settleCommissionSplit: (ctx: ServiceContext, input: {
    invoiceId: string; planId?: string | undefined;
    shares: readonly { technicianId: string; weight: string }[]; reason?: string | undefined;
  }) => settleSplit(ctx, input),

  settleCommissionSplitsAsProposed: (ctx: ServiceContext, input: {
    invoiceIds: readonly string[]; planId?: string | undefined;
  }) => settleProposed(ctx, input),

  listCommissionStandingShares: (ctx: ServiceContext) => standingShares(ctx),

  setCommissionStandingShare: (ctx: ServiceContext, input: {
    technicianId: string; percent: number; applies: "always" | "as_lead"; reason: string;
  }) => setStandingShare(ctx, input),

  endCommissionStandingShare: (ctx: ServiceContext, input: { id: string }) => endStandingShare(ctx, input),

  listCommissionEarnings: (ctx: ServiceContext, input: {
    technicianId?: string | undefined; from?: string | undefined; to?: string | undefined;
  }) => earnings(ctx, input),
} as const;

/**
 * Shares as a query string carries them: `id:2,id:1`. Anything that does not
 * read is refused in words rather than dropped, because a split missing a
 * person is a different split.
 */
export function parseShares(text: string): ShareInput[] {
  return text.split(",").map((pair) => pair.trim()).filter((pair) => pair !== "").map((pair) => {
    const [technicianId, weight] = pair.split(":");
    if (!technicianId || weight === undefined || !/^[0-9a-f-]{36}$/i.test(technicianId)) {
      throw new UnprocessableError("Not a split", [{ path: "shares", message: `"${pair}" is not a person and a share.` }]);
    }
    return { technicianId, weight: weight.trim() };
  });
}
