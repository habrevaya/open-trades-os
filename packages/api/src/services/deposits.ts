import { eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { estimate as est, ledger, money as m } from "@opentradesos/core";
import type { z } from "zod";
import {
  type ServiceContext, guardedWrite, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
import { writePosting } from "./ledger";
import type { requestDeposit, applyDeposit, refundDeposit } from "../contracts/estimates";

const usd = (v: string) => m.money(v, "USD");

/**
 * DEPOSITS
 *
 * Money held against work not yet done. It is a liability from the moment it
 * arrives and stays one until the work is performed, and every function here
 * exists to make that the path of least resistance rather than something a
 * bookkeeper has to remember.
 *
 * The four events are four different postings because they mean four
 * different things, and collapsing any two of them produces a P and L that
 * reads wrong in a way nobody notices for a quarter. See packages/core/ledger.
 */

/**
 * Asking for a deposit.
 *
 * Nothing is posted here. A request is not money: the posting happens when
 * the payment arrives, through `record`.
 */
export async function request(ctx: ServiceContext, input: z.infer<typeof requestDeposit.input>) {
  return guardedWrite(ctx, "deposit:collect", async (tx) => {
    let amount: string;
    let percent: string | null = null;

    if (input.amount !== undefined) {
      amount = input.amount;
    } else {
      const total = await subjectTotal(tx, ctx, input);
      percent = input.percent!;
      amount = m.toString(est.computeDeposit(usd(total), {
        percent,
        ...(input.maximum ? { maximum: usd(input.maximum) } : {}),
      }));
    }

    if (!m.isPositive(usd(amount))) {
      throw new ConflictError(
        "That policy asks for nothing. Set an amount, or a percent of a priced estimate.",
      );
    }

    const [row] = await tx.insert(schema.deposit).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId,
      estimateId: input.estimateId ?? null,
      jobId: input.jobId ?? null,
      status: "requested",
      amountRequested: amount,
      percentOfTotal: percent,
    }).returning();

    await audit(tx, ctx, "deposit.requested", "deposit", row!.id, null,
      { amount, percent });

    return shape(row!);
  });
}

/**
 * The money arrives.
 *
 * Cash up, liability up, nothing earned and no sales tax recognised: tax is
 * owed when the sale is recognised, not when the cash turns up.
 */
export async function record(
  ctx: ServiceContext,
  input: { depositId: string; amount: string; paymentId?: string; processingFee?: string },
) {
  return guardedWrite(ctx, "deposit:collect", async (tx) => {
    const row = await load(tx, input.depositId);

    if (row.status === "refunded" || row.status === "forfeited") {
      throw new ConflictError(`This deposit is ${row.status} and cannot take a payment.`);
    }

    const received = m.add(usd(row.amountReceived), usd(input.amount));

    await writePosting(tx, ctx, ledger.postDeposit({
      depositId: row.id,
      occurredAt: new Date(),
      amount: usd(input.amount),
      ...(input.processingFee ? { processingFee: usd(input.processingFee) } : {}),
      customerId: row.customerId,
      ...(row.jobId ? { jobId: row.jobId } : {}),
    }));

    await tx.update(schema.deposit).set({
      status: "held",
      amountReceived: m.toString(received),
      paymentId: input.paymentId ?? row.paymentId,
      receivedAt: row.receivedAt ?? new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.deposit.id, row.id));

    await audit(tx, ctx, "deposit.received", "deposit", row.id,
      { amountReceived: row.amountReceived }, { amountReceived: m.toString(received) });

    return shape(await load(tx, row.id));
  });
}

/**
 * Applying a held deposit to an invoice.
 *
 * Never more than the deposit has left and never more than the invoice is
 * asking for. Applying a $2,000 deposit to a $1,400 first invoice and leaving
 * the customer with a $600 credit they have to ring up about is what the
 * ceiling prevents: the remainder stays held against the next invoice.
 */
export async function apply(ctx: ServiceContext, input: z.infer<typeof applyDeposit.input>) {
  return guardedWrite(ctx, "deposit:collect", async (tx) => {
    const row = await load(tx, input.id);

    if (row.status !== "held" && row.status !== "applied") {
      throw new ConflictError(`This deposit is ${row.status} and cannot be applied.`);
    }

    const [invoice] = await tx.select({
      id: schema.invoice.id,
      balance: schema.invoice.balance,
      depositHeld: schema.invoice.depositHeld,
      status: schema.invoice.status,
    }).from(schema.invoice).where(eq(schema.invoice.id, input.invoiceId)).limit(1);
    if (!invoice) throw new NotFoundError("Invoice");

    const amount = est.applicableDeposit({
      heldAmount: usd(row.amountReceived),
      alreadyApplied: usd(row.amountApplied),
      invoiceBalance: usd(invoice.balance),
    });

    // Nothing left, or nothing owed. Not an error: a retry lands here, and so
    // does a deposit that was fully consumed by an earlier invoice.
    if (!m.isPositive(amount)) return { deposit: shape(row), amountApplied: m.toString(amount) };

    await writePosting(tx, ctx, ledger.postDepositApplication({
      depositId: row.id,
      occurredAt: new Date(),
      amount,
      customerId: row.customerId,
      ...(row.jobId ? { jobId: row.jobId } : {}),
    }));

    const applied = m.add(usd(row.amountApplied), amount);
    const balance = m.subtract(usd(invoice.balance), amount);

    await tx.update(schema.invoice).set({
      balance: m.toString(balance),
      depositHeld: m.toString(m.add(usd(invoice.depositHeld), amount)),
      status: m.isZero(balance) ? "paid" : "partially_paid",
      updatedAt: new Date(),
    }).where(eq(schema.invoice.id, invoice.id));

    await tx.update(schema.deposit).set({
      status: "applied",
      amountApplied: m.toString(applied),
      appliedInvoiceId: invoice.id,
      appliedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.deposit.id, row.id));

    await audit(tx, ctx, "deposit.applied", "deposit", row.id,
      { amountApplied: row.amountApplied },
      { amountApplied: m.toString(applied), invoiceId: invoice.id });

    return { deposit: shape(await load(tx, row.id)), amountApplied: m.toString(amount) };
  });
}

/**
 * Giving it back, or keeping it.
 *
 * Two different postings under one route because they are two dispositions of
 * the same decision, and the caller has to say which. A refund returns cash
 * and touches no revenue, because nothing was sold. A forfeiture earns the
 * money without moving any cash, because the cash already arrived.
 */
export async function refund(ctx: ServiceContext, input: z.infer<typeof refundDeposit.input>) {
  return guardedWrite(ctx, "deposit:refund", async (tx) => {
    const row = await load(tx, input.id);

    if (row.status === "refunded" || row.status === "forfeited") {
      // A retry is a no-op only when it agrees with what was already done.
      // Refunding a forfeited deposit is a different decision, not a repeat.
      const already = row.status === "refunded" ? "refund" : "forfeit";
      if (already === input.disposition) return shape(row);
      throw new ConflictError(`This deposit was already ${row.status}.`);
    }

    const outstanding = m.subtract(usd(row.amountReceived), usd(row.amountApplied));
    const amount = input.amount ? usd(input.amount) : outstanding;

    if (m.compare(amount, outstanding) > 0) {
      throw new ConflictError(
        `Only ${m.toString(outstanding)} is still held on this deposit.`,
      );
    }
    if (!m.isPositive(amount)) {
      throw new ConflictError("There is nothing left on this deposit.");
    }

    const posting = input.disposition === "refund"
      ? ledger.postDepositRefund({
          depositId: row.id, occurredAt: new Date(), amount, customerId: row.customerId,
        })
      : ledger.postDepositForfeiture({
          depositId: row.id, occurredAt: new Date(), amount, customerId: row.customerId,
        });

    await writePosting(tx, ctx, posting);

    await tx.update(schema.deposit).set({
      status: input.disposition === "refund" ? "refunded" : "forfeited",
      amountRefunded: input.disposition === "refund"
        ? m.toString(m.add(usd(row.amountRefunded), amount))
        : row.amountRefunded,
      updatedAt: new Date(),
    }).where(eq(schema.deposit.id, row.id));

    await audit(tx, ctx, `deposit.${input.disposition}ed`, "deposit", row.id,
      { status: row.status }, { amount: m.toString(amount), reason: input.reason ?? null });

    return shape(await load(tx, row.id));
  });
}

/**
 * The figure a percentage is taken of.
 *
 * The approved option where there is one, because that is what the customer
 * agreed to. Taking a percentage of the most expensive option a company
 * offered, rather than the one chosen, overcharges by exactly the spread the
 * options exist to create.
 */
async function subjectTotal(
  tx: Database, ctx: ServiceContext, input: z.infer<typeof requestDeposit.input>,
): Promise<string> {
  if (!input.estimateId) {
    throw new ConflictError(
      "A percentage deposit needs an estimate to take a percentage of. Set an amount instead.",
    );
  }

  const [row] = await tx.select({
    selectedOptionId: schema.estimate.selectedOptionId,
  }).from(schema.estimate).where(eq(schema.estimate.id, input.estimateId)).limit(1);
  if (!row) throw new NotFoundError("Estimate");

  const options = await tx.select({
    id: schema.estimateOption.id,
    total: schema.estimateOption.total,
    isRecommended: schema.estimateOption.isRecommended,
  }).from(schema.estimateOption)
    .where(eq(schema.estimateOption.estimateId, input.estimateId));

  if (options.length === 0) throw new NotFoundError("Estimate option");

  const chosen = row.selectedOptionId
    ? options.find((o) => o.id === row.selectedOptionId)
    : undefined;

  if (chosen) return chosen.total;

  // Not yet approved. The recommended option is the company's own answer to
  // "which one", and falling back to it is closer to right than the largest.
  const recommended = options.find((o) => o.isRecommended);
  return (recommended ?? options[0]!).total;
}

async function load(tx: Database, id: string) {
  const [row] = await tx.select().from(schema.deposit)
    .where(eq(schema.deposit.id, id)).limit(1);
  if (!row) throw new NotFoundError("Deposit");
  return row;
}

function shape(row: typeof schema.deposit.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    customerId: row.customerId,
    estimateId: row.estimateId,
    jobId: row.jobId,
    appliedInvoiceId: row.appliedInvoiceId,
    currency: row.currency,
    amountRequested: row.amountRequested,
    amountReceived: row.amountReceived,
    amountApplied: row.amountApplied,
    amountRefunded: row.amountRefunded,
    percentOfTotal: row.percentOfTotal,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
