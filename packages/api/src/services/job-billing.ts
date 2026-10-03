import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { coverage, money as m, rates, splits, time } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as rateCards from "./rate-cards";
import * as billing from "./billing";
import * as commercial from "./commercial";
import * as entitlements from "./entitlements";
import * as contractClocks from "./contract-clocks";
import { remember, replayed } from "./once";

/**
 * BILLING A JOB, BY WHOEVER PAYS FOR IT
 *
 * The invoice composer starts from what a person types. This starts from the
 * job: every unbilled line recorded on it, plus the card's trip charge per
 * visit, each priced by the authority of whoever pays for that line, and cut
 * between payers when more than one does. The answer is shown before anything
 * is written (`preview`), and billing the job (`bill`) writes exactly what
 * was shown, as one invoice per payer, in one transaction: a split either
 * produces every invoice or none of them.
 *
 * THREE SHAPES, read from the job rather than chosen on a form:
 *
 *   single    one payer, which is the residential case and the plain
 *             commercial one: whoever the job is billed to, priced by their
 *             card if they have one.
 *   coverage  a third party covers part of the work: a home warranty company,
 *             a manufacturer, a carrier. They pay the covered work, priced by
 *             their schedule, less the deductible; the customer pays the
 *             deductible and whatever is not covered.
 *   shares    payers named on the job with a share each, and whoever the job
 *             is billed to paying the rest.
 *
 * And a fourth that bills less than the work: coverage nobody is invoiced
 * for, a maintenance plan or our own callback, where the covered part is
 * absorbed and shown on the customer's invoice at nothing.
 *
 * THE INVOICES ADD UP TO THE WORK. Every line is priced once, and the split
 * is arithmetic on those prices (`core/splits`), so the invoices plus what
 * was absorbed equal the priced total to the cent. That is checked again
 * after the invoices are written, and a mismatch rolls the whole lot back
 * rather than leaving two documents that disagree with the job.
 */

const usd = (value: string) => m.money(value, "USD");
const ZERO = usd("0");

export type PlanBasis = "single" | "coverage" | "shares" | "absorbed";

export interface PlanLine {
  key: string;
  jobLineId: string | null;
  priceBookItemId: string | null;
  name: string;
  kind: rates.WorkKind;
  chargeKind: coverage.ChargeKind;
  quantity: string;
  unitPrice: string;
  amount: string;
  authority: rates.PriceAuthority;
  authorityLabel: string;
  basis: rates.PriceBasis;
  note: string | null;
  rateCardId: string | null;
  rateCardLineId: string | null;
  outOfScope: boolean;
  taxable: boolean;
}

export interface PayerPart {
  customerId: string;
  name: string;
  role: "third_party" | "customer" | "share";
  total: string;
  /** Each line this payer pays any of, with how much. */
  lines: Array<{ key: string; amount: string; whole: boolean }>;
  /** What the client's limit says about this payer's invoice. */
  ceiling: { state: "within" | "over"; held: boolean; message: string | null } | null;
}

export interface BillingPlan {
  jobId: string;
  jobNumber: number;
  basis: PlanBasis;
  coverage: { source: coverage.CoverageSource; label: string } | null;
  lines: PlanLine[];
  payers: PayerPart[];
  pricedTotal: string;
  invoicedTotal: string;
  absorbed: string;
  reconciles: boolean;
  outOfScope: number;
  /** Why the job cannot be billed this way yet, in words somebody can act on. */
  problems: string[];
  /** The live invoices already on the job, so a second run is not a surprise. */
  existing: Array<{ id: string; number: number; customerName: string; total: string; status: string }>;
}

/* ------------------------------------------------------------- the plan */

async function nameOf(tx: Database, customerId: string): Promise<string> {
  const [row] = await tx.select({ name: schema.customer.name }).from(schema.customer)
    .where(eq(schema.customer.id, customerId)).limit(1);
  return row?.name ?? "A customer";
}

/**
 * Work out who pays for what on a job, priced, without writing anything.
 *
 * Inside a caller's transaction, so `bill` acts on exactly the plan it read.
 */
export async function planIn(tx: Database, organizationId: string, jobId: string): Promise<BillingPlan> {
  const [job] = await tx.select().from(schema.job)
    .where(and(eq(schema.job.id, jobId), isNull(schema.job.deletedAt))).limit(1);
  if (!job) throw new NotFoundError("Job");
  const problems: string[] = [];

  const parties = await tx.select().from(schema.jobParty).where(eq(schema.jobParty.jobId, jobId));
  const billTo = parties.find((p) => p.role === "bill_to" && p.customerId)?.customerId ?? null;
  const primary = billTo ?? job.customerId;
  const payerParties = parties.filter((p) => p.role === "payer" && p.customerId && p.customerId !== primary);
  const unrecorded = parties.filter((p) => p.role === "payer" && !p.customerId);
  if (unrecorded.length > 0) {
    problems.push(
      `${unrecorded.map((p) => p.externalName ?? "A payer").join(", ")} pays, but has no customer record. `
      + "Add them as a customer and choose them under Pays, so their invoice has somebody to age against.",
    );
  }

  const terms = await entitlements.termsFor(tx, jobId);
  const profile = terms ? coverage.COVERAGE[terms.source] : null;

  let basis: PlanBasis = "single";
  let thirdParty: string | null = null;
  if (terms && terms.source !== "customer") {
    if (profile!.billsAThirdParty) {
      basis = "coverage";
      if (payerParties.length === 0) {
        problems.push(
          `This job is covered by ${profile!.label.toLowerCase()}, and nobody is named as who pays for the covered work. Choose them under Pays.`,
        );
      } else if (payerParties.length > 1) {
        problems.push("More than one payer is named for covered work. Covered work has one payer: keep one under Pays.");
      } else {
        thirdParty = payerParties[0]!.customerId!;
      }
    } else {
      basis = "absorbed";
    }
  } else if (payerParties.some((p) => p.sharePercent || p.shareAmount)) {
    basis = "shares";
    const without = payerParties.filter((p) => !p.sharePercent && !p.shareAmount);
    if (without.length > 0) {
      problems.push("Every payer other than the one billed needs a share. The one billed pays what is left.");
    }
  }

  /** Whose cards price each kind of line. */
  const today = await rateCards.todayFor(tx, organizationId);
  const cardsOf = new Map<string, rates.CardTerms[]>();
  const cardsFor = async (customerId: string) => {
    if (!cardsOf.has(customerId)) {
      cardsOf.set(customerId, await rateCards.cardsFor(tx, organizationId, {
        customerId, contractId: job.contractId, ...today,
      }));
    }
    return cardsOf.get(customerId)!;
  };

  const unbilled = await tx.select().from(schema.jobLine)
    .where(and(eq(schema.jobLine.jobId, jobId), isNull(schema.jobLine.invoiceLineId), isNull(schema.jobLine.nonBillableReason)))
    .orderBy(schema.jobLine.occurredAt, schema.jobLine.createdAt);
  const recorded = await rateCards.jobLinesFor(tx, unbilled.map((l) => l.id));

  const chargeKind = (kind: rates.WorkKind): coverage.ChargeKind =>
    kind === "labor" ? "labour" : kind === "part" || kind === "equipment" ? "parts" : kind === "trip" ? "trip" : "other";
  const covered = (kind: coverage.ChargeKind) => terms !== null && (
    kind === "labour" ? terms.coversLabour : kind === "parts" ? terms.coversParts : kind === "trip" ? terms.coversTrip : false);
  /** Covered work is priced by the third party's cards; everything else by the payer billed. */
  const pricerFor = (kind: coverage.ChargeKind) => (thirdParty && covered(kind) ? thirdParty : primary);

  const lines: PlanLine[] = [];
  for (const row of unbilled) {
    const facts = recorded.get(row.id)!;
    const kind = chargeKind(facts.kind);
    const cards = await cardsFor(pricerFor(kind));
    const priced = rates.priceWork(cards, {
      kind: facts.kind,
      name: row.name,
      priceBookItemId: facts.itemId,
      quantity: row.quantity,
      ourPrice: usd(row.unitPrice),
      ourPriceIsBook: row.priceBookItemVersionId !== null,
      unitCost: row.unitCost ? usd(row.unitCost) : null,
      at: facts.at,
      jobTypeId: job.jobTypeId,
    });
    lines.push(lineOf(`line:${row.id}`, row.id, facts.itemId, row.name, facts.kind, kind, priced, row.taxable));
  }

  /**
   * The trip, once per visit somebody actually made, from the card of
   * whoever pays for trips. Added only when a card charges one: our own
   * price book's call out fee is something the office adds by choice, and
   * adding it here would bill a residential customer twice for turning up.
   */
  const [{ visits } = { visits: 0 }] = await tx.select({
    visits: sql<number>`count(*)::int`,
  }).from(schema.visit).where(and(
    eq(schema.visit.jobId, jobId),
    inArray(schema.visit.status, ["working", "completed"]),
  ));
  const alreadyTripped = await tx.select({ id: schema.invoiceLine.id }).from(schema.invoiceLine)
    .innerJoin(schema.invoice, eq(schema.invoice.id, schema.invoiceLine.invoiceId))
    .where(and(
      eq(schema.invoice.jobId, jobId),
      eq(schema.invoiceLine.priceBasis, "trip_charge"),
      inArray(schema.invoice.status, ["draft", "open", "partially_paid", "paid", "written_off"]),
    ));
  const tripCards = await cardsFor(pricerFor("trip"));
  const trip = rates.tripChargeOf(tripCards);
  if (trip && Number(visits) > 0 && alreadyTripped.length === 0) {
    const priced = rates.priceWork([trip.card], {
      kind: "trip", name: "Trip charge", priceBookItemId: null, quantity: String(visits),
      ourPrice: trip.amount, ourPriceIsBook: false, unitCost: null, at: new Date(), jobTypeId: job.jobTypeId,
    });
    lines.push(lineOf("trip", null, null, "Trip charge", "trip", "trip", priced, false));
  }

  const amounts = lines.map((l) => usd(l.amount));
  const pricedTotal = m.sum(amounts, "USD");
  if (lines.length === 0) problems.push("Nothing on this job is still to bill. Record what was used on it first.");

  /** The targets, by shape. */
  let payers: Array<{ customerId: string | null; role: PayerPart["role"] }> = [];
  let targets: m.Money[] = [];
  let eligible: boolean[][] | undefined;
  if (basis === "coverage" || basis === "absorbed") {
    const split = splits.coverageTargets(terms!, lines.map((l) => ({ amount: usd(l.amount), kind: l.chargeKind })));
    const thirdPart = m.round(split.thirdParty, 2);
    targets = [thirdPart, m.subtract(pricedTotal, thirdPart)];
    eligible = [split.eligible, lines.map(() => true)];
    payers = [
      { customerId: basis === "coverage" ? thirdParty : null, role: "third_party" },
      { customerId: primary, role: "customer" },
    ];
  } else if (basis === "shares") {
    const sharing = payerParties.filter((p) => p.sharePercent || p.shareAmount);
    const result = splits.shareTargets(pricedTotal, [
      ...sharing.map((p) => ({
        percent: p.sharePercent ?? null,
        amount: p.shareAmount ? usd(p.shareAmount) : null,
      })),
      {},
    ]);
    if (!result.ok) {
      problems.push(result.reason);
      targets = [pricedTotal];
      payers = [{ customerId: primary, role: "customer" }];
    } else {
      targets = result.targets;
      payers = [
        ...sharing.map((p) => ({ customerId: p.customerId!, role: "share" as const })),
        { customerId: primary, role: "customer" },
      ];
    }
  } else {
    targets = [pricedTotal];
    payers = [{ customerId: primary, role: "customer" }];
  }

  let parts: m.Money[][] = payers.map(() => lines.map(() => ZERO));
  if (lines.length > 0) {
    try {
      parts = splits.allocateAcross(amounts, targets, eligible);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  const absorbed = basis === "absorbed" ? m.sum(parts[0] ?? [], "USD") : ZERO;
  const ceiling = await commercial.ceilingFor(tx, jobId);
  const result: PayerPart[] = [];
  for (const [p, payer] of payers.entries()) {
    if (!payer.customerId) continue;
    const mine = parts[p] ?? [];
    const total = m.sum(mine, "USD");
    const verdict = await ceilingOf(tx, organizationId, {
      jobId, customerId: payer.customerId, amount: total, authorization: ceiling,
      governs: payer.role === "third_party" || basis !== "coverage",
    });
    result.push({
      customerId: payer.customerId,
      name: await nameOf(tx, payer.customerId),
      role: payer.role,
      total: m.toString(total),
      lines: lines.flatMap((line, i) => {
        const amount = mine[i] ?? ZERO;
        /**
         * A line wholly absorbed by a plan or our own warranty stays on the
         * customer's invoice at nothing, so the document shows it was done
         * and why it is free.
         */
        const keepAtZero = basis === "absorbed" && payer.role === "customer" && m.isZero(amount);
        if (m.isZero(amount) && !keepAtZero) return [];
        return [{ key: line.key, amount: m.toString(amount), whole: m.equals(amount, amounts[i]!) }];
      }),
      ceiling: verdict,
    });
    if (verdict?.held && verdict.message) problems.push(verdict.message);
  }

  const invoicedTotal = m.sum(result.map((r) => usd(r.total)), "USD");
  const existing = await tx.select({
    id: schema.invoice.id, number: schema.invoice.number, total: schema.invoice.total,
    status: schema.invoice.status, customerName: schema.customer.name,
  }).from(schema.invoice)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
    .where(and(eq(schema.invoice.jobId, jobId), isNull(schema.invoice.deletedAt),
      inArray(schema.invoice.status, ["draft", "open", "partially_paid", "paid", "written_off"])));

  return {
    jobId,
    jobNumber: job.number,
    basis,
    coverage: terms && terms.source !== "customer"
      ? { source: terms.source, label: coverage.COVERAGE[terms.source].label } : null,
    lines,
    payers: result,
    pricedTotal: m.toString(pricedTotal),
    invoicedTotal: m.toString(invoicedTotal),
    absorbed: m.toString(absorbed),
    reconciles: splits.reconciles(pricedTotal, [invoicedTotal, absorbed]).ok,
    outOfScope: lines.filter((l) => l.outOfScope).length,
    problems,
    existing,
  };
}

function lineOf(
  key: string, jobLineId: string | null, itemId: string | null, name: string,
  kind: rates.WorkKind, chargeKind: coverage.ChargeKind, priced: rates.PricedLine, taxable: boolean,
): PlanLine {
  return {
    key,
    jobLineId,
    priceBookItemId: itemId,
    name,
    kind,
    chargeKind,
    quantity: priced.quantity,
    unitPrice: m.toString(priced.unitPrice),
    amount: m.toString(m.round(m.multiply(priced.unitPrice, priced.quantity), 2)),
    authority: priced.authority,
    authorityLabel: rates.AUTHORITY_LABEL[priced.authority],
    basis: priced.basis,
    note: priced.note,
    rateCardId: priced.rateCardId,
    rateCardLineId: priced.rateCardLineId,
    outOfScope: priced.outOfScope,
    taxable,
  };
}

/**
 * The limit that governs one payer's part: the job's authorisation when it
 * belongs to them, otherwise their contract's not to exceed.
 */
async function ceilingOf(
  tx: Database, organizationId: string,
  input: {
    jobId: string; customerId: string; amount: m.Money; governs: boolean;
    authorization: Awaited<ReturnType<typeof commercial.ceilingFor>>;
  },
): Promise<PayerPart["ceiling"]> {
  if (input.authorization && input.governs) {
    const left = input.authorization.terms.amount
      ? m.subtract(input.authorization.terms.amount, input.authorization.terms.consumed) : null;
    const verdict = rates.ceilingVerdict({
      amount: input.amount,
      alreadyBilled: input.authorization.terms.consumed,
      ceiling: input.authorization.terms.amount ?? null,
      action: "hold",
      source: `What ${input.authorization.grantedByName ?? "the client"} authorised`,
    });
    if (verdict.state === "none" || left === null) return null;
    return { state: verdict.state === "over" ? "over" : "within", held: verdict.held, message: verdict.message };
  }
  if (input.authorization) return null;
  const verdict = await rateCards.contractCeilingFor(tx, organizationId, {
    jobId: input.jobId, customerId: input.customerId, amount: input.amount,
  });
  if (!verdict) return null;
  return { state: verdict.state === "over" ? "over" : "within", held: verdict.held, message: verdict.message };
}

export async function preview(ctx: ServiceContext, input: { jobId: string }): Promise<BillingPlan> {
  return guardedRead(ctx, "invoice:read", (tx) => planIn(tx, ctx.actor.organizationId, input.jobId));
}

/* ------------------------------------------------------------- billing */

export interface BillResult {
  jobId: string;
  basis: PlanBasis;
  invoices: Array<{ id: string; number: number; customerId: string; customerName: string; total: string; role: string }>;
  pricedTotal: string;
  invoicedTotal: string;
  absorbed: string;
}

/**
 * Bill the job as the plan says: one invoice per payer, all or none.
 *
 * Refused while the plan has a problem, with the problem as the reason,
 * because each one is a decision a person has to make first: who pays for
 * the covered work, what share somebody pays, or whether the client will
 * raise their limit.
 */
export async function bill(
  ctx: ServiceContext, input: { jobId: string; draft?: boolean | undefined },
): Promise<BillResult> {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const seen = await replayed<BillResult>(tx, ctx, "job_billing");
    if (seen) return seen;

    const plan = await planIn(tx, ctx.actor.organizationId, input.jobId);
    if (plan.problems.length > 0) throw new ConflictError(plan.problems.join(" "));

    const [job] = await tx.select().from(schema.job).where(eq(schema.job.id, input.jobId)).limit(1);
    const terms = await entitlements.termsFor(tx, input.jobId);
    const byKey = new Map(plan.lines.map((line) => [line.key, line]));
    const allowedPayers = plan.payers.map((p) => p.customerId);

    /** The job line goes with the first payer who pays any of it, so it is marked billed once. */
    const owner = new Map<string, string>();
    for (const payer of plan.payers) {
      for (const part of payer.lines) {
        const line = byKey.get(part.key)!;
        if (line.jobLineId && !owner.has(line.jobLineId)) owner.set(line.jobLineId, payer.customerId);
      }
    }

    /** One invoice per payer, each created by the same path every invoice is. */
    const { idempotencyKey: _key, ...inner } = ctx;
    const created: BillResult["invoices"] = [];
    const others = (payer: PayerPart) => plan.payers.filter((p) => p !== payer).map((p) => p.name);
    for (const payer of plan.payers) {
      if (payer.lines.length === 0) continue;
      const lineInputs = payer.lines.map((part) => {
        const line = byKey.get(part.key)!;
        const share = !part.whole;
        const sourceOf = (): coverage.CoverageSource | undefined => {
          if (plan.basis === "coverage") return payer.role === "third_party" ? terms!.source : "customer";
          if (plan.basis === "absorbed") return m.isZero(usd(part.amount)) ? undefined : "customer";
          return undefined;
        };
        const source = sourceOf();
        return {
          input: {
            ...(line.priceBookItemId ? { priceBookItemId: line.priceBookItemId } : {}),
            name: line.name,
            ...(share ? {
              description: `${m.edit(usd(part.amount))} of ${m.edit(usd(line.amount))}. `
                + `The rest is billed to ${others(payer).join(" and ") || "nobody"}`
                + (plan.basis === "absorbed" ? " or covered" : "") + ".",
            } : {}),
            quantity: share ? "1" : line.quantity,
            unitPrice: share ? part.amount : line.unitPrice,
            discountAmount: "0",
            taxable: line.taxable,
            ...(source ? { coverageSource: source } : {}),
            ...(line.jobLineId && owner.get(line.jobLineId) === payer.customerId ? { jobLineId: line.jobLineId } : {}),
          },
          prepared: {
            unitPrice: usd(share ? part.amount : line.unitPrice),
            quantity: share ? "1" : line.quantity,
            authority: line.authority,
            basis: share ? "share" as const : line.basis,
            note: share
              ? `${line.authorityLabel}: ${line.note ?? m.edit(usd(line.amount))} This payer's part is ${m.edit(usd(part.amount))}.`
              : line.note,
            rateCardId: line.rateCardId,
            rateCardLineId: line.rateCardLineId,
          } satisfies billing.PreparedLine,
        };
      });

      const invoice = await billing.createIn(tx, inner, {
        customerId: payer.customerId,
        jobId: input.jobId,
        ...(job!.purchaseOrderNumber ? { purchaseOrderNumber: job!.purchaseOrderNumber } : {}),
        ...(input.draft ? { draft: true } : {}),
        ...(plan.payers.length > 1 ? {
          memo: `Job ${plan.jobNumber} is billed in ${plan.payers.length} parts. This is ${payer.name}'s part; the rest is billed to ${others(payer).join(" and ")}.`,
        } : {}),
        lines: lineInputs.map((l) => l.input),
      } as Parameters<typeof billing.createIn>[2], {
        prepared: lineInputs.map((l) => l.prepared),
        allowedPayers,
        applyCoverage: false,
        memberPricing: false,
        applyCeiling: plan.basis !== "coverage" || payer.role === "third_party",
      });
      created.push({
        id: invoice.id as string,
        number: invoice.number as number,
        customerId: payer.customerId,
        customerName: payer.name,
        total: invoice.total as string,
        role: payer.role,
      });
    }

    /**
     * The check that makes a split worth trusting, made on what was written
     * rather than on what was planned: the invoices plus whatever was
     * absorbed come to the priced work, to the cent. If tax or rounding ever
     * made them disagree, nothing is kept.
     */
    const subtotals = await tx.select({ subtotal: schema.invoice.subtotal, discount: schema.invoice.discountTotal })
      .from(schema.invoice).where(inArray(schema.invoice.id, created.map((c) => c.id)));
    const written = m.sum(subtotals.map((s) => m.subtract(usd(s.subtotal), usd(s.discount))), "USD");
    const check = splits.reconciles(usd(plan.pricedTotal), [written, usd(plan.absorbed)]);
    if (!check.ok) {
      throw new ConflictError(
        `The invoices come to ${m.edit(written)} and the work to ${m.edit(usd(plan.pricedTotal))}. Nothing was billed.`,
      );
    }

    await contractClocks.reconcileJob(tx, ctx.actor.organizationId, input.jobId);
    const result: BillResult = {
      jobId: input.jobId,
      basis: plan.basis,
      invoices: created,
      pricedTotal: plan.pricedTotal,
      invoicedTotal: m.toString(written),
      absorbed: plan.absorbed,
    };
    await audit(tx, ctx, "job.billed", "job", input.jobId, null, result);
    await remember(tx, ctx, "job_billing", input.jobId, result);
    return result;
  });
}

/* ------------------------------------------------- the job's contract */

/**
 * Say which contract a job runs under, or that none does.
 *
 * Only a contract with somebody on the job: its customer, or a party
 * named on it. A contract with a stranger to the job would price the work
 * at a card nobody here agreed and start clocks nobody owes.
 */
export async function setContract(
  ctx: ServiceContext, input: { jobId: string; contractId: string | null },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [job] = await tx.select().from(schema.job)
      .where(and(eq(schema.job.id, input.jobId), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");
    let priceSource = "price_book";
    if (input.contractId) {
      const [contract] = await tx.select().from(schema.serviceContract)
        .where(and(eq(schema.serviceContract.id, input.contractId), isNull(schema.serviceContract.deletedAt))).limit(1);
      if (!contract) throw new NotFoundError("Contract");
      const involved = new Set([job.customerId, ...(await tx.select({ id: schema.jobParty.customerId })
        .from(schema.jobParty).where(eq(schema.jobParty.jobId, job.id))).map((p) => p.id)]);
      if (!involved.has(contract.customerId)) {
        throw new ConflictError(
          `${contract.name} is with ${await nameOf(tx, contract.customerId)}, who is not on this job. Name them on the job first.`,
        );
      }
      const [card] = await tx.select({ authority: schema.rateCard.authority }).from(schema.rateCard)
        .where(and(eq(schema.rateCard.contractId, contract.id), isNull(schema.rateCard.deletedAt))).limit(1);
      if (card) priceSource = PRICE_SOURCE[card.authority] ?? "rate_card";
    }
    const [after] = await tx.update(schema.job).set({
      contractId: input.contractId, priceSource, updatedAt: new Date(),
    }).where(eq(schema.job.id, job.id)).returning();
    await audit(tx, ctx, "job.contract_set", "job", job.id, { contractId: job.contractId }, { contractId: input.contractId });
    await contractClocks.reconcileJob(tx, ctx.actor.organizationId, job.id);
    return { jobId: after!.id, contractId: after!.contractId, priceSource: after!.priceSource };
  });
}

/** A card's authority, as the job's own record of whose price governs it. */
const PRICE_SOURCE: Record<string, string> = {
  contract: "rate_card",
  warranty_network: "warranty_schedule",
  manufacturer_allowance: "manufacturer_allowance",
  insurance: "insurance_schedule",
};

/** The contract clocks on a job, as the job screen and the API show them. */
export async function clocks(ctx: ServiceContext, input: { jobId: string }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const governed = await contractClocks.governingContract(tx, ctx.actor.organizationId, input.jobId);
    if (!governed) throw new NotFoundError("Job");
    return {
      contract: governed.contract
        ? { id: governed.contract.id, name: governed.contract.name, customerId: governed.contract.customerId }
        : null,
      named: governed.job.contractId !== null,
      clocks: await contractClocks.clocksOf(tx, ctx.actor.organizationId, input.jobId),
    };
  });
}

/* ------------------------------------------- coverage from the unit */

export type EquipmentCoverage =
  | { resolved: true; source: coverage.CoverageSource; coversParts: boolean; coversLabour: boolean; on: string; note: string }
  | { resolved: false; on: string; reason: string };

/**
 * Who is paying, read from the unit's own warranty dates.
 *
 * On the day of the visit rather than today, because that is the day the
 * warranty had to be in force: a repair done in March under a parts
 * warranty that ended in April was covered, whenever the invoice is raised.
 * Parts and labour separately, because they end separately, and getting
 * them backwards bills a customer for something a manufacturer owed.
 *
 * Out of warranty is said rather than written down as the customer paying.
 * That is a decision, and the office may know about a goodwill extension
 * the dates do not.
 */
export async function coverageFromEquipment(
  ctx: ServiceContext, input: { jobId: string; equipmentId?: string | undefined; on?: string | undefined },
): Promise<EquipmentCoverage> {
  const found = await guardedRead(ctx, "job:write", async (tx) => {
    const [job] = await tx.select().from(schema.job)
      .where(and(eq(schema.job.id, input.jobId), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");
    const equipmentId = input.equipmentId ?? job.equipmentId;
    if (!equipmentId) {
      throw new ConflictError("Name the unit this job is about. Without one there are no warranty dates to read.");
    }
    const [unit] = await tx.select().from(schema.equipment)
      .where(and(eq(schema.equipment.id, equipmentId), isNull(schema.equipment.deletedAt))).limit(1);
    if (!unit) throw new NotFoundError("Equipment");
    if (unit.propertyId !== job.propertyId) {
      throw new ConflictError("That unit is at another address. A warranty covers the unit the work was done on.");
    }
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const [first] = await tx.select({ at: schema.visit.arrivedAt, window: schema.visit.windowStart })
      .from(schema.visit).where(eq(schema.visit.jobId, job.id))
      .orderBy(schema.visit.sequence).limit(1);
    const visited = first?.at ?? first?.window ?? null;
    const on = input.on ?? time.dateIn(visited ?? new Date(), zone);
    return { unit, on };
  });

  const { unit, on } = found;
  const parts = unit.warrantyPartsExpiresOn !== null && unit.warrantyPartsExpiresOn >= on;
  const labour = unit.warrantyLaborExpiresOn !== null && unit.warrantyLaborExpiresOn >= on;
  const named = [unit.manufacturer, unit.model, unit.serialNumber ? `serial ${unit.serialNumber}` : null]
    .filter(Boolean).join(" ") || unit.category;

  if (!parts && !labour) {
    const ended = [unit.warrantyPartsExpiresOn, unit.warrantyLaborExpiresOn].filter(Boolean).sort().pop();
    return {
      resolved: false,
      on,
      reason: ended
        ? `The ${named} was out of warranty on ${on}: its cover ended on ${ended}. Nothing was changed.`
        : `The ${named} has no warranty dates recorded. Add them to the unit, or say who is paying by hand.`,
    };
  }

  const note = `From the ${named}: parts ${parts ? `covered to ${unit.warrantyPartsExpiresOn}` : "not covered"}, `
    + `labour ${labour ? `covered to ${unit.warrantyLaborExpiresOn}` : "not covered"}, on ${on}.`;
  const source: coverage.CoverageSource = parts ? "parts_warranty" : "labour_warranty";
  await entitlements.resolve(ctx, {
    jobId: input.jobId,
    equipmentId: unit.id,
    source,
    grantingEntityType: "equipment",
    grantingEntityId: unit.id,
    coversParts: parts,
    coversLabour: labour,
    coversTrip: false,
    notes: note,
  });
  return { resolved: true, source, coversParts: parts, coversLabour: labour, on, note };
}

/* --------------------------------------------------------------- handlers */

type PartyRole = Parameters<typeof commercial.setParties>[1]["parties"][number]["role"];

export const handlers = {
  previewJobBilling: (ctx: ServiceContext, input: { id: string }) => preview(ctx, { jobId: input.id }),
  billJob: (ctx: ServiceContext, input: { id: string; draft?: boolean | undefined }) =>
    bill(ctx, { jobId: input.id, draft: input.draft }),
  setJobContract: (ctx: ServiceContext, input: { id: string; contractId: string | null }) =>
    setContract(ctx, { jobId: input.id, contractId: input.contractId }),
  listJobClocks: (ctx: ServiceContext, input: { id: string }) => clocks(ctx, { jobId: input.id }),
  resolveCoverageFromEquipment: (ctx: ServiceContext, input: {
    id: string; equipmentId?: string | undefined; on?: string | undefined;
  }) => coverageFromEquipment(ctx, { jobId: input.id, equipmentId: input.equipmentId, on: input.on }),
  setJobParties: async (ctx: ServiceContext, input: {
    id: string;
    parties: Array<{
      role: PartyRole;
      customerId?: string | undefined; contactId?: string | undefined;
      externalName?: string | undefined; externalReference?: string | undefined;
      sharePercent?: string | undefined; shareAmount?: string | undefined;
      notes?: string | undefined;
    }>;
  }) => {
    const rows = await commercial.setParties(ctx, {
      jobId: input.id,
      parties: input.parties.map((p) => Object.fromEntries(
        Object.entries(p).filter(([, v]) => v !== undefined),
      ) as unknown as commercial.PartyInput),
    });
    return {
      parties: rows.map((row) => ({
        id: row.id, role: row.role, customerId: row.customerId, contactId: row.contactId,
        externalName: row.externalName, externalReference: row.externalReference,
        sharePercent: row.sharePercent, shareAmount: row.shareAmount,
      })),
    };
  },
  setJobCoverage: async (ctx: ServiceContext, input: {
    id: string;
    source: coverage.CoverageSource | null;
    externalReference?: string | undefined;
    coversLabour?: boolean | undefined; coversParts?: boolean | undefined; coversTrip?: boolean | undefined;
    coveragePercent?: string | undefined; coverageLimit?: string | undefined;
    customerResponsibility?: string | undefined; notes?: string | undefined;
  }) => {
    if (input.source === null) {
      await entitlements.clear(ctx, { jobId: input.id });
      return { source: null, coversLabour: null, coversParts: null, coversTrip: null };
    }
    const { id, source, ...rest } = input;
    const row = await entitlements.resolve(ctx, {
      jobId: id, source,
      ...(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as
        Omit<entitlements.ResolveInput, "jobId" | "source">),
    });
    return { source: row.source, coversLabour: row.coversLabour, coversParts: row.coversParts, coversTrip: row.coversTrip };
  },
} as const;
