import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { labor, ledger, money as m } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { writePosting } from "./ledger";
import { closedPeriodCovering } from "./payroll";

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
  return guardedWrite(ctx, "commission:configure", async (tx) => {
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
    const shares = await resolveShares(tx, ctx, invoice.jobId, input.shares);

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
    };

    const verdict = labor.computeCommission(toCorePlan(plan), event);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

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
        explanation: part.explanation,
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
      invoiceId: invoice.id, planId: plan.id, total: m.toString(verdict.total),
      parts: verdict.parts.map((p) => ({ technicianId: p.personId, amount: m.toString(p.amount) })),
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
      occurredAt,
      ledgerTransactionId: transactionId,
      parts: verdict.parts.map((part, index) => ({
        technicianId: part.personId,
        weight: shares[index]!.weight,
        amount: m.toString(part.amount),
        explanation: part.explanation,
      })),
    };
  });
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
    const rows = await tx.select({
      entry: schema.commissionEntry,
      technicianName: schema.technician.displayName,
      invoiceId: schema.commissionEvent.invoiceId,
      invoiceNumber: schema.invoice.number,
    }).from(schema.commissionEntry)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.commissionEntry.technicianId))
      .innerJoin(schema.commissionEvent, eq(schema.commissionEvent.id, schema.commissionEntry.eventId))
      .innerJoin(schema.invoice, eq(schema.invoice.id, schema.commissionEvent.invoiceId))
      .where(and(
        eq(schema.commissionEntry.organizationId, ctx.actor.organizationId),
        ...(input.technicianId ? [eq(schema.commissionEntry.technicianId, input.technicianId)] : []),
        ...(input.from ? [gte(schema.commissionEntry.occurredAt, new Date(`${input.from}T00:00:00.000Z`))] : []),
        ...(input.to ? [lte(schema.commissionEntry.occurredAt, new Date(`${input.to}T23:59:59.999Z`))] : []),
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
): Promise<ShareInput[]> {
  let shares: ShareInput[];

  if (given && given.length > 0) {
    shares = given.map((share) => ({ technicianId: share.technicianId, weight: share.weight }));
  } else {
    if (!jobId) {
      throw new ConflictError(
        "This invoice is not against a job, so there is nobody to infer a split from. "
        + "Name who the commission is for.",
      );
    }
    const assigned = await tx.selectDistinct({ technicianId: schema.visitAssignment.technicianId })
      .from(schema.visitAssignment)
      .innerJoin(schema.visit, eq(schema.visit.id, schema.visitAssignment.visitId))
      .where(eq(schema.visit.jobId, jobId))
      .orderBy(asc(schema.visitAssignment.technicianId));
    if (assigned.length === 0) {
      throw new ConflictError(
        "Nobody is assigned to that job's visits, so there is nobody to pay the commission to. "
        + "Name the split.",
      );
    }
    shares = assigned.map((row) => ({ technicianId: row.technicianId, weight: "1" }));
  }

  const seen = new Set<string>();
  for (const share of shares) {
    if (seen.has(share.technicianId)) {
      /**
       * A technician named twice is a split that pays them two shares, and the
       * weights still sum to the whole, so the commission is right and one
       * person's half of it is wrong. Nothing downstream can see it.
       */
      throw new ConflictError("The same technician appears twice in that split.");
    }
    seen.add(share.technicianId);
    if (!/^\d+(\.\d{1,6})?$/.test(share.weight)) {
      throw new ConflictError(`"${share.weight}" is not a share weight. Weights are positive decimals, such as "2" and "1".`);
    }
  }

  /**
   * `money.allocate` throws a RangeError on weights summing to zero, which
   * would surface as a five hundred. Refused here with a sentence instead,
   * because a split of zeros is a real thing somebody types when they mean
   * nobody should be paid.
   */
  if (shares.every((share) => !m.isPositive(usd(share.weight)))) {
    throw new ConflictError(
      "Every share in that split is zero, so there is nothing to divide. "
      + "Leave the commission unsettled instead.",
    );
  }

  const ids = shares.map((share) => share.technicianId);
  const known = await tx.select({ id: schema.technician.id }).from(schema.technician)
    .where(and(
      eq(schema.technician.organizationId, ctx.actor.organizationId),
      inArray(schema.technician.id, ids),
    ));
  if (known.length !== ids.length) {
    throw new NotFoundError("Technician in that split");
  }

  return shares;
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

  listCommissionEarnings: (ctx: ServiceContext, input: {
    technicianId?: string | undefined; from?: string | undefined; to?: string | undefined;
  }) => earnings(ctx, input),
} as const;
