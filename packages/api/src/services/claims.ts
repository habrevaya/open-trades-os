import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema, type Database } from "@opentradesos/db";
import { claims as rules, coverage, money as m, work } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as billing from "./billing";
import { createInvoice } from "../contracts/billing";
import * as contractClocks from "./contract-clocks";
import { remember, replayed } from "./once";

/**
 * BILLING THE THIRD PARTY: THE CLAIM
 *
 * The invoice addressed to a home warranty company, a manufacturer or a
 * carrier is the receivable: it is on the ledger against them and ages like
 * any other. The claim is the conversation about it, and it is its own
 * document because it has its own life: their reference, their approval,
 * often for less than we asked, sometimes a denial after the work was done,
 * and a payment that may not match either.
 *
 * Filing a claim is what meets the claim deadline the contract set (see
 * services/contract-clocks.ts), so a claim filed is a clock satisfied with
 * the time it was filed.
 *
 * A payment against a claim is a real payment, recorded by the same path as
 * every other (`billing.pay`), applied to the claim's invoice. The claim's
 * paid amount is then read back from the invoice rather than added up here,
 * so the two cannot disagree, and a retried request that finds the payment
 * already recorded still brings the claim up to date.
 */

const usd = (value: string) => m.money(value, "USD");

const stateOf = (row: typeof schema.coverageClaim.$inferSelect): rules.ClaimState => ({
  status: row.status,
  claimed: usd(row.claimedAmount),
  approved: row.approvedAmount ? usd(row.approvedAmount) : null,
  paid: usd(row.paidAmount),
});

export interface ClaimView {
  id: string;
  jobId: string;
  jobNumber: number;
  invoiceId: string;
  invoiceNumber: number;
  invoiceBalance: string;
  payerCustomerId: string;
  payerName: string;
  source: coverage.CoverageSource;
  sourceLabel: string;
  status: rules.ClaimStatus;
  claimedAmount: string;
  approvedAmount: string | null;
  paidAmount: string;
  /** What is still expected from them. Zero once paid or denied. */
  outstanding: string;
  /** Approved but not paid, or paid short: what the payer has decided not to pay. */
  shortfall: string;
  externalReference: string | null;
  submittedAt: Date;
  decidedAt: Date | null;
  paidAt: Date | null;
  decisionNote: string | null;
  /** The invoice to the customer for what the payer did not pay, once somebody billed it on. Null when none stands. */
  billedInvoice: { id: string; number: string; status: string; total: string } | null;
  /**
   * Whether "Bill the rest to the customer" can be pressed now, and for how
   * much, or why not, in the words the refusal would use.
   */
  billOn: { amount: string | null; refusal: string | null };
}

/** The invoice made from a claim, alias of the invoice table for the second join. */
const billed = alias(schema.invoice, "billed_invoice");

/** A draft deleted is gone; a voided one no longer bills anybody. Either way the claim can be billed on again. */
const stands = (status: string | null | undefined) => status != null && status !== "void";

async function views(tx: Database, where: ReturnType<typeof and>, limit = 200): Promise<ClaimView[]> {
  const rows = await tx.select({
    claim: schema.coverageClaim,
    jobNumber: schema.job.number,
    invoiceNumber: schema.invoice.number,
    invoiceBalance: schema.invoice.balance,
    payerName: schema.customer.name,
    billed: {
      id: billed.id, number: billed.number, prefix: billed.numberPrefix, status: billed.status,
      total: billed.total, deletedAt: billed.deletedAt,
    },
  }).from(schema.coverageClaim)
    .innerJoin(schema.job, eq(schema.job.id, schema.coverageClaim.jobId))
    .innerJoin(schema.invoice, eq(schema.invoice.id, schema.coverageClaim.invoiceId))
    .innerJoin(schema.customer, eq(schema.customer.id, schema.coverageClaim.payerCustomerId))
    .leftJoin(billed, eq(billed.id, schema.coverageClaim.billedInvoiceId))
    .where(where)
    .orderBy(desc(schema.coverageClaim.submittedAt))
    .limit(limit);
  return rows.map(({ claim, ...row }) => {
    const state = stateOf(claim);
    const shortfall = claim.status === "short_paid"
      ? m.subtract(rules.expectedOf(state), state.paid)
      : claim.approvedAmount ? m.subtract(state.claimed, usd(claim.approvedAmount)) : usd("0");
    return {
      id: claim.id,
      jobId: claim.jobId,
      jobNumber: row.jobNumber,
      invoiceId: claim.invoiceId,
      invoiceNumber: row.invoiceNumber,
      invoiceBalance: row.invoiceBalance,
      payerCustomerId: claim.payerCustomerId,
      payerName: row.payerName,
      source: claim.source,
      sourceLabel: coverage.COVERAGE[claim.source].label,
      status: claim.status,
      claimedAmount: claim.claimedAmount,
      approvedAmount: claim.approvedAmount,
      paidAmount: claim.paidAmount,
      outstanding: m.toString(rules.outstanding(state)),
      shortfall: m.toString(m.isNegative(shortfall) ? usd("0") : shortfall),
      externalReference: claim.externalReference,
      submittedAt: claim.submittedAt,
      decidedAt: claim.decidedAt,
      paidAt: claim.paidAt,
      decisionNote: claim.decisionNote,
      ...billedView(state, row.invoiceBalance, row.billed),
    };
  });
}

function billedView(
  state: rules.ClaimState, payerOwes: string,
  row: { id: string | null; number: number | null; prefix: string | null; status: string | null; total: string | null; deletedAt: Date | null } | null,
): Pick<ClaimView, "billedInvoice" | "billOn"> {
  const live = row?.id && row.number !== null && row.deletedAt === null && stands(row.status) ? row : null;
  const billedInvoice = live ? {
    id: live.id!, number: work.documentNumber(live.prefix, live.number!), status: live.status!, total: live.total!,
  } : null;
  const verdict = rules.billOn(state, { payerOwes: usd(payerOwes), alreadyBilled: billedInvoice?.number ?? null });
  return {
    billedInvoice,
    billOn: verdict.ok ? { amount: m.toString(verdict.amount), refusal: null } : { amount: null, refusal: verdict.reason },
  };
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.coverageClaim)
    .where(and(eq(schema.coverageClaim.id, id), eq(schema.coverageClaim.organizationId, organizationId))).limit(1);
  if (!row) throw new NotFoundError("Claim");
  return row;
}

async function viewOne(tx: Database, organizationId: string, id: string): Promise<ClaimView> {
  const [view] = await views(tx, and(
    eq(schema.coverageClaim.organizationId, organizationId), eq(schema.coverageClaim.id, id),
  ));
  if (!view) throw new NotFoundError("Claim");
  return view;
}

export async function list(
  ctx: ServiceContext, input: { status?: rules.ClaimStatus[] | undefined; jobId?: string | undefined } = {},
): Promise<ClaimView[]> {
  return guardedRead(ctx, "invoice:read", (tx) => views(tx, and(
    eq(schema.coverageClaim.organizationId, ctx.actor.organizationId),
    ...(input.status?.length ? [inArray(schema.coverageClaim.status, input.status)] : []),
    ...(input.jobId ? [eq(schema.coverageClaim.jobId, input.jobId)] : []),
  )));
}

export async function get(ctx: ServiceContext, input: { id: string }): Promise<ClaimView> {
  return guardedRead(ctx, "invoice:read", (tx) => viewOne(tx, ctx.actor.organizationId, input.id));
}

/**
 * File a claim on the invoice addressed to whoever covers the work.
 *
 * Refused on an invoice to the job's own customer, because a claim is a
 * request to somebody else to pay, and on a job whose coverage bills nobody
 * else: our own warranty and goodwill are costs we absorb, and a claim
 * against them would be a receivable on ourselves.
 */
export async function file(
  ctx: ServiceContext, input: { invoiceId: string; externalReference?: string | undefined },
): Promise<ClaimView> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await replayed<{ id: string }>(tx, ctx, "coverage_claim");
    if (seen) return viewOne(tx, ctx.actor.organizationId, seen.id);

    const [invoice] = await tx.select().from(schema.invoice)
      .where(and(eq(schema.invoice.id, input.invoiceId), isNull(schema.invoice.deletedAt))).limit(1);
    if (!invoice) throw new NotFoundError("Invoice");
    if (!invoice.jobId) throw new ConflictError("A claim is for work on a job. This invoice is not for a job.");
    if (invoice.status === "draft" || invoice.status === "void") {
      throw new ConflictError(`Invoice ${invoice.number} is ${invoice.status}. Claim on an issued invoice.`);
    }
    const [job] = await tx.select().from(schema.job).where(eq(schema.job.id, invoice.jobId)).limit(1);
    const [terms] = await tx.select({ source: schema.entitlement.source }).from(schema.entitlement)
      .where(eq(schema.entitlement.jobId, invoice.jobId)).limit(1);
    if (!terms || !coverage.COVERAGE[terms.source].billsAThirdParty) {
      throw new ConflictError(
        "This job's coverage bills nobody else, so there is nobody to claim against. Say who is paying on the job first.",
      );
    }
    const payer = invoice.payerCustomerId ?? invoice.customerId;
    if (payer === job!.customerId) {
      throw new ConflictError(
        `Invoice ${invoice.number} is the customer's own. A claim goes on the invoice to whoever covers the work.`,
      );
    }
    /**
     * Checked first and refused in words, rather than left to
     * `coverage_claim_invoice_idx`: two claims on one receivable are two
     * answers to what the payer agreed to pay.
     */
    const [existing] = await tx.select({ id: schema.coverageClaim.id }).from(schema.coverageClaim)
      .where(eq(schema.coverageClaim.invoiceId, invoice.id)).limit(1);
    if (existing) {
      throw new ConflictError(`Invoice ${invoice.number} already has a claim. Update that one rather than filing another.`);
    }

    const [row] = await tx.insert(schema.coverageClaim).values({
      organizationId: ctx.actor.organizationId,
      jobId: invoice.jobId,
      invoiceId: invoice.id,
      payerCustomerId: payer,
      source: terms.source,
      claimedAmount: invoice.total,
      paidAmount: invoice.amountPaid,
      externalReference: input.externalReference?.trim() || null,
    }).returning();

    await contractClocks.reconcileJob(tx, ctx.actor.organizationId, invoice.jobId);
    await audit(tx, ctx, "claim.filed", "coverage_claim", row!.id, null, row!);
    await remember(tx, ctx, "coverage_claim", row!.id, { id: row!.id });
    return viewOne(tx, ctx.actor.organizationId, row!.id);
  });
}

/** What they said: approved, perhaps for less, or denied with their reason. */
export async function decide(
  ctx: ServiceContext,
  input: {
    id: string; outcome: "approved" | "denied"; amount?: string | undefined;
    note?: string | undefined; externalReference?: string | undefined;
  },
): Promise<ClaimView> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    const decision = rules.decide(stateOf(before), {
      outcome: input.outcome,
      amount: input.amount ? usd(input.amount) : null,
      note: input.note ?? null,
    });
    if (!decision.ok) {
      /** A replay of the same decision is the decision already made, not a refusal. */
      if (before.status === input.outcome && before.status === "denied") return viewOne(tx, ctx.actor.organizationId, before.id);
      throw new ConflictError(decision.reason);
    }
    const [after] = await tx.update(schema.coverageClaim).set({
      status: decision.status,
      approvedAmount: decision.approved ? m.toString(decision.approved) : null,
      decidedAt: new Date(),
      decisionNote: input.note?.trim() || null,
      ...(input.externalReference?.trim() ? { externalReference: input.externalReference.trim() } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.coverageClaim.id, before.id)).returning();
    await audit(tx, ctx, `claim.${decision.status}`, "coverage_claim", before.id, before, after!);
    return viewOne(tx, ctx.actor.organizationId, before.id);
  });
}

/**
 * Money arrived from them.
 *
 * Checked against the claim first, so a payment over what they agreed is
 * refused before anything is recorded. Then recorded as a payment from the
 * payer, applied to the claim's invoice, and the claim brought up to date
 * from what the invoice now says it has been paid.
 */
export async function recordPayment(
  ctx: ServiceContext,
  input: {
    id: string; amount: string;
    method: "check" | "ach" | "card" | "other";
    reference?: string | undefined; receivedAt?: string | undefined;
  },
): Promise<ClaimView> {
  const before = await guardedRead(ctx, "invoice:read", (tx) => load(tx, ctx.actor.organizationId, input.id));
  const amount = usd(input.amount);

  /**
   * A retried request finds the payment already recorded under its key and
   * the claim already moved, so the check below is skipped for it: it is
   * the same money, not more of it.
   */
  const alreadyRecorded = ctx.idempotencyKey
    ? await guardedRead(ctx, "invoice:read", async (tx) => {
        const [seen] = await tx.select({ id: schema.integrationEvent.id }).from(schema.integrationEvent)
          .where(and(
            eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey!),
            eq(schema.integrationEvent.entityType, "payment"),
          )).limit(1);
        return Boolean(seen);
      })
    : false;
  if (!alreadyRecorded) {
    const check = rules.settle(stateOf(before), amount);
    if (!check.ok) throw new ConflictError(check.reason);
  }

  await billing.pay(ctx, {
    customerId: before.payerCustomerId,
    method: input.method,
    amount: m.toString(amount),
    tipAmount: "0",
    ...(input.method === "check" && input.reference ? { checkNumber: input.reference.slice(0, 50) } : {}),
    notes: `Claim payment${input.reference ? `, their reference ${input.reference}` : ""}.`,
    ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
    allocations: [{ invoiceId: before.invoiceId, amount: m.toString(amount) }],
  });

  return guardedWrite(ctx, "payment:collect", async (tx) => {
    const claim = await load(tx, ctx.actor.organizationId, input.id);
    const [invoice] = await tx.select({ amountPaid: schema.invoice.amountPaid }).from(schema.invoice)
      .where(eq(schema.invoice.id, claim.invoiceId)).limit(1);
    const paid = usd(invoice!.amountPaid);
    const expected = rules.expectedOf(stateOf(claim));
    const status: rules.ClaimStatus = m.compare(paid, expected) >= 0 ? "paid" : "short_paid";
    const [after] = await tx.update(schema.coverageClaim).set({
      paidAmount: m.toString(paid),
      status,
      paidAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.coverageClaim.id, claim.id)).returning();
    await audit(tx, ctx, "claim.payment_recorded", "coverage_claim", claim.id, claim, after!);
    return viewOne(tx, ctx.actor.organizationId, claim.id);
  });
}

/**
 * BILL THE REST TO THE CUSTOMER.
 *
 * When the payer paid less than was claimed, or nothing, the office can ask
 * the customer for the rest: a DRAFT invoice to the job's own customer for
 * what was claimed less what the payer paid, one line saying what it is.
 * Explicit and per claim, pressed by a person on the claim's page, never done
 * by itself, because whether a homeowner owes what their warranty would not
 * pay is a conversation the office has with them. A draft posts nothing, so
 * the office reads it, changes it if the conversation went another way, and
 * issues it or deletes it.
 *
 * Refused, in core's words (`claims.billOn`), when the payer has not
 * finished with the claim, when their invoice still owes the money (credit it
 * or write it off there first, so it is never owed by two people and never
 * counted as revenue twice), when it was already billed on, and when there is
 * nothing to bill. A draft deleted or an invoice voided no longer stands, and
 * the claim can be billed on again.
 *
 * The line names the customer as who pays it (`coverageSource: customer`), so
 * the job's coverage does not take its share off again, and it is not
 * taxable: what was claimed already carried the tax charged on the work. The
 * office can change both on the draft.
 */
export async function billRest(ctx: ServiceContext, input: { id: string }): Promise<ClaimView> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await replayed<{ id: string }>(tx, ctx, "coverage_claim_bill_on");
    if (seen) return viewOne(tx, ctx.actor.organizationId, seen.id);

    const claim = await load(tx, ctx.actor.organizationId, input.id);
    /** One person at a time per claim, so two presses cannot make two invoices. */
    await tx.select({ id: schema.coverageClaim.id }).from(schema.coverageClaim)
      .where(eq(schema.coverageClaim.id, claim.id)).for("update");
    const view = await viewOne(tx, ctx.actor.organizationId, claim.id);
    if (!view.billOn.amount) throw new ConflictError(view.billOn.refusal ?? "This claim cannot be billed on.");

    const [job] = await tx.select({ customerId: schema.job.customerId, number: schema.job.number, prefix: schema.job.numberPrefix })
      .from(schema.job).where(eq(schema.job.id, claim.jobId)).limit(1);
    if (!job) throw new NotFoundError("Job");
    const reference = claim.externalReference ? ` (their reference ${claim.externalReference})` : "";
    const description = `${view.sourceLabel}, ${view.payerName}${reference}, was claimed ${m.format(m.round(usd(claim.claimedAmount), 2))} `
      + `for job ${work.documentNumber(job.prefix, job.number)} and paid ${m.format(m.round(usd(claim.paidAmount), 2))}`
      + `${claim.status === "denied" ? ", having denied the claim" : ""}. This is the rest.`;

    /** Without the caller's key: that key is this claim's, and the invoice is answered through it above. */
    const { idempotencyKey: _key, ...plain } = ctx;
    const invoice = await billing.createIn(tx, { ...plain, db: tx }, createInvoice.input.parse({
      customerId: job.customerId,
      jobId: claim.jobId,
      draft: true,
      lines: [{
        name: `Not paid by ${view.payerName}`,
        description,
        quantity: "1",
        unitPrice: view.billOn.amount,
        discountAmount: "0",
        taxable: false,
        coverageSource: "customer",
      }],
    }));

    const now = new Date();
    const [after] = await tx.update(schema.coverageClaim)
      .set({ billedInvoiceId: invoice.id as string, billedAt: now, updatedAt: now })
      .where(eq(schema.coverageClaim.id, claim.id)).returning();
    await audit(tx, ctx, "claim.billed_on", "coverage_claim", claim.id, claim, {
      ...after!, amount: view.billOn.amount,
    });
    await remember(tx, ctx, "coverage_claim_bill_on", claim.id, { id: claim.id });
    return viewOne(tx, ctx.actor.organizationId, claim.id);
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listClaims: async (ctx: ServiceContext, input: { status?: rules.ClaimStatus[] | undefined; jobId?: string | undefined }) =>
    ({ claims: await list(ctx, input) }),
  getClaim: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  fileClaim: (ctx: ServiceContext, input: { invoiceId: string; externalReference?: string | undefined }) => file(ctx, input),
  decideClaim: (ctx: ServiceContext, input: {
    id: string; outcome: "approved" | "denied"; amount?: string | undefined;
    note?: string | undefined; externalReference?: string | undefined;
  }) => decide(ctx, input),
  billClaimRestToCustomer: (ctx: ServiceContext, input: { id: string }) => billRest(ctx, input),
  recordClaimPayment: (ctx: ServiceContext, input: {
    id: string; amount: string; method: "check" | "ach" | "card" | "other";
    reference?: string | undefined; receivedAt?: string | undefined;
  }) => recordPayment(ctx, input),
} as const;
