import { and, asc, eq, desc, lt, gte, lte, inArray, sql, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { authorization as authz, coverage, history, ledger, money as m, time } from "@opentradesos/core";
import type { z } from "zod";
import {
  audit, type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError,
  scopeOf, timezoneOf, UnprocessableError,
} from "./context";
import { admitDate, admitInstant, requireImport } from "./history";
import { invoiceScopeFilter } from "./scope";
import { inForceAt } from "./pricebook";
import { writePosting } from "./ledger";
import { emit } from "./events";
import * as contracts from "./contracts";
import * as obligations from "./obligations";
import { claimNumber } from "./jobs";
import { assertUnclaimed, byExternal, provenance } from "./provenance";
import * as entitlements from "./entitlements";
import * as commercial from "./commercial";
import type { createInvoice, listInvoices, getInvoice, recordPayment, getArAging, listPayments as listPayments_ } from "../contracts/billing";

const usd = (v: string) => m.money(v, "USD");

/**
 * Creating an invoice.
 *
 * Totals are computed server side from the lines and a client supplied total
 * is ignored. That is not distrust of our own web app, it is that the same API
 * serves a third party integration, an AI agent and an offline mobile client,
 * and exactly one of them should be allowed to decide what something costs.
 */
export async function create(ctx: ServiceContext, input: z.infer<typeof createInvoice.input>) {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "invoice"),
        )).limit(1);
      if (seen?.entityId) return loadInvoice(tx, ctx, seen.entityId);
    }

    /**
     * THE DAY IT WAS ISSUED, which used to be whatever day the request
     * arrived. A migrated invoice from 2023 was issued on the day of the
     * cutover, the aging report put all of them in "current", and ten years
     * of revenue landed in one month. The date is admitted by the same rules
     * as every other business date (see services/history.ts), and the
     * posting below is dated by it.
     */
    const now = new Date();
    const admitted = input.issuedOn
      ? await admitDate(tx, ctx, input.issuedOn, "issuedOn")
      : { historical: false, timeZone: await timezoneOf(tx, ctx.actor.organizationId) };
    const issuedOn = input.issuedOn ?? time.dateIn(now, admitted.timeZone);

    /**
     * Prices come from the price book VERSION, not from the request, whenever
     * an item id is given. A client that can name its own price is a client
     * that will, and the version reference is what keeps an old invoice saying
     * what it said after a price rise.
     */
    const itemIds = input.lines.map((l) => l.priceBookItemId).filter((x): x is string => Boolean(x));
    const versions = itemIds.length
      ? await tx.select({
          itemId: schema.priceBookItemVersion.itemId,
          versionId: schema.priceBookItemVersion.id,
          name: schema.priceBookItemVersion.name,
          price: schema.priceBookItemVersion.price,
          cost: schema.priceBookItemVersion.cost,
          taxable: schema.priceBookItemVersion.taxable,
        })
        .from(schema.priceBookItemVersion)
        .where(and(
          inArray(schema.priceBookItemVersion.itemId, itemIds),
          /**
           * The version IN FORCE, not the open ended one. `isNull(effectiveTo)`
           * picks a revision dated ahead, so a price increase scheduled for
           * next month applied today and the price actually in force became
           * invisible. The reasoning is on `inForceAt`.
           */
          inForceAt(),
        ))
      : [];
    const byItem = new Map(versions.map((v) => [v.itemId, v]));

    /**
     * WHOSE PRICE GOVERNS, PER LINE.
     *
     * Our price book is not the authority when the customer holds a
     * contract with a rate card: the schema has said so since it was
     * written, and until now nothing read it, so every commercial job
     * invoiced at our list price and got rejected.
     *
     * Resolved per line rather than once per invoice, because a card covers
     * some items and not others. A line the card prices takes the card's
     * price; a line it does not is left at ours AND recorded, so the caller
     * is told rather than finding out when the client rejects the invoice.
     *
     * COST IS NEVER TAKEN FROM THE CARD. The price is theirs and the cost is
     * ours, which is the whole reason margin reporting still works on work
     * we did not price.
     */
    const contracted = new Map<string, contracts.PriceResolution>();
    const uncovered: string[] = [];
    for (const itemId of new Set(itemIds)) {
      const resolution = await contracts.priceFor(ctx, {
        customerId: input.customerId,
        priceBookItemId: itemId,
      });
      contracted.set(itemId, resolution);
      if (!resolution.covered && resolution.cardApplies) {
        uncovered.push(byItem.get(itemId)?.name ?? itemId);
      }
    }

    /**
     * TAX AS CHARGED, AND PRICES AS CHARGED, ARE HISTORY ONLY.
     *
     * Deciding what something costs and what tax is owed on it today is this
     * server's job, for the reason at the top of this function. Recording
     * what another system charged in 2021 is a different act, and the power
     * to state a tax or keep a price the price book disagrees with is the
     * power to make an invoice say anything, so it needs `data:import`.
     */
    if (input.lines.some((l) => l.taxRate !== undefined || l.taxAmount !== undefined || l.priceAsGiven)) {
      requireImport(ctx);
    }

    const resolved = input.lines.map((line) => {
      const linked = line.priceBookItemId ? byItem.get(line.priceBookItemId) : undefined;
      /**
       * A line kept as given still links the item, so "which invoices sold
       * this" has an answer, and takes nothing else from it: the name,
       * price, cost and taxability are what the source charged.
       */
      const version = line.priceAsGiven ? undefined : linked;
      const contract = line.priceBookItemId && !line.priceAsGiven ? contracted.get(line.priceBookItemId) : undefined;
      const contractPrice = contract?.covered ? contract.price : undefined;
      return {
        name: version?.name ?? line.name,
        description: line.description ?? null,
        quantity: line.quantity,
        unitPrice: usd(contractPrice ?? version?.price ?? line.unitPrice),
        unitCost: version?.cost ? usd(version.cost) : null,
        discountAmount: usd(line.discountAmount),
        taxable: version?.taxable ?? line.taxable,
        /**
         * Resolved per jurisdiction in phase 5. Zero until then, honestly,
         * unless the line is history and says what it was taxed at.
         */
        taxRate: line.taxRate ?? "0",
        taxAmount: line.taxAmount === undefined ? undefined : usd(line.taxAmount),
        costCode: line.costCode ?? null,
        versionId: linked?.versionId ?? null,
        coverageSource: line.coverageSource ?? null,
        origin: "job" as "job" | "manual",
      };
    });

    /**
     * AN AMOUNT THE LINES DO NOT ACCOUNT FOR.
     *
     * An invoice-wide discount, or a manual adjustment, had nowhere to go:
     * the total is computed from lines and there was no line for it. It
     * becomes one, at the end and marked `manual`, never taxable. A negative
     * amount is a DISCOUNT rather than a negative price, so it posts to
     * contra revenue like every other discount instead of quietly netting
     * revenue down.
     */
    if (input.adjustment) {
      const amount = usd(input.adjustment.amount);
      if (m.isZero(amount)) {
        throw new UnprocessableError("An adjustment of nothing is not an adjustment", [{
          path: "adjustment.amount", message: "Send a non-zero amount, or leave the adjustment off.",
        }]);
      }
      const negative = m.isNegative(amount);
      resolved.push({
        name: input.adjustment.name,
        description: null,
        quantity: "1",
        unitPrice: negative ? usd("0") : amount,
        unitCost: null,
        discountAmount: negative ? m.negate(amount) : usd("0"),
        taxable: false,
        taxRate: "0",
        taxAmount: undefined,
        costCode: null,
        versionId: null,
        coverageSource: null,
        origin: "manual",
      });
    }

    /**
     * WORK THE CUSTOMER DOES NOT PAY FOR MUST NOT REACH THEM.
     *
     * A guard rather than a calculation. The sources this refuses on are the
     * ones where billing the customer is not a pricing question but a
     * mistake: we are back because of something we did, or we chose to
     * absorb it. Rework billed to a customer is the complaint that ends a
     * relationship, and it happens because the person invoicing was not the
     * person who decided.
     *
     * A line's own `coverageSource` wins over the job's, because a job can
     * be a callback with one chargeable extra on it.
     */
    const terms = input.jobId ? await entitlements.termsFor(tx, input.jobId) : null;
    if (terms) {
      /**
       * Only the lines that INHERIT the job's coverage are tested. A line
       * that names its own source was an explicit decision by whoever wrote
       * it, including naming the customer: a callback can have one
       * chargeable extra on it, and refusing that would make the guard
       * something people work around rather than with.
       */
      const charges = resolved
        .filter((r) => r.coverageSource == null)
        .map((r) => ({
          kind: chargeKindOf(r.name, r.costCode),
          amount: m.multiply(r.unitPrice, r.quantity),
        }));
      const refusal = entitlements.refusalFor(terms, charges);
      if (refusal) throw new ConflictError(refusal);
    }

    let computed: ReturnType<typeof ledger.computeInvoice>;
    try {
      computed = ledger.computeInvoice(resolved.map((r) => ({
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        discountAmount: r.discountAmount,
        taxable: r.taxable,
        taxRate: r.taxRate,
        ...(r.taxAmount ? { taxAmount: r.taxAmount } : {}),
      })));
    } catch (error) {
      if (error instanceof ledger.TaxAsAppliedError) {
        throw new UnprocessableError("A line's tax is not what its rate gives", [{
          path: `lines.${error.line}.taxAmount`, message: error.message,
        }]);
      }
      throw error;
    }

    /**
     * The caller's totals, compared and never used. See the contract.
     */
    if (input.expectedTotals) {
      const expected: Partial<Record<keyof ledger.InvoiceTotals, ReturnType<typeof usd>>> = {};
      for (const [field, value] of Object.entries(input.expectedTotals)) {
        if (value !== undefined) expected[field as keyof ledger.InvoiceTotals] = usd(value);
      }
      const wrong = ledger.totalsMismatch(computed.totals, expected);
      if (wrong.length > 0) {
        throw new UnprocessableError("The invoice does not add up to the totals expected", wrong.map((w) => ({
          path: `expectedTotals.${w.field}`,
          message: `Expected ${w.expected}; the lines give ${w.computed}.`,
        })));
      }
    }

    /**
     * THE INVOICE GOES TO WHOEVER IS BEING BILLED, NOT TO WHOEVER IS ON SITE.
     *
     * A property manager orders the work, a tenant is there, an owner pays.
     * The product assumed one customer holding every role, and an invoice
     * addressed to the tenant is a document the payer will not accept and
     * the tenant should never have seen.
     *
     * Nobody named means the residential case, where the job's customer is
     * all of them, and nothing about that gets harder.
     */
    if (input.jobId) {
      const billTo = await commercial.billToFor(tx, input.jobId);
      if (billTo?.customerId && billTo.customerId !== input.customerId) {
        const [who] = await tx.select({ name: schema.customer.name })
          .from(schema.customer).where(eq(schema.customer.id, billTo.customerId)).limit(1);
        throw new ConflictError(
          `This job is billed to ${who?.name ?? "another party"}, not to the customer on the invoice.`,
        );
      }
    }

    /**
     * AND IT MAY NOT GO OVER WHAT THEY AUTHORISED.
     *
     * A facilities network authorises five hundred, the technician finds
     * more wrong, the office invoices nine hundred, and the network pays
     * five hundred and disputes the rest. The four hundred is not a
     * receivable, it is a write-off, and nobody notices until the aging
     * report has a column of them.
     *
     * Checked here rather than reconstructed afterwards, against the total
     * the invoice will actually carry.
     */
    const ceiling = input.jobId ? await commercial.ceilingFor(tx, input.jobId) : null;
    if (ceiling) {
      const decision = authz.decide(ceiling.terms, computed.totals.total);
      if (!decision.ok) throw new ConflictError(decision.detail);
    }

    await assertUnclaimed(tx, "invoice", input.externalRef);
    const number = await claimNumber(tx, ctx, "invoice", input.number);

    const [invoice] = await tx.insert(schema.invoice).values({
      organizationId: ctx.actor.organizationId,
      number,
      customerId: input.customerId,
      payerCustomerId: input.payerCustomerId ?? null,
      jobId: input.jobId ?? null,
      purchaseOrderNumber: input.purchaseOrderNumber ?? null,
      /**
       * WHICH AUTHORIZATION GOVERNED THIS INVOICE.
       *
       * The column's own comment says "Set when a ceiling governs this
       * invoice, so a breach is checkable", and nothing set it, so the answer
       * to "what were we authorised for when we billed this" was always null.
       *
       * The ceiling itself IS enforced, twenty lines above: an invoice over
       * the limit is refused before it exists. What was missing is narrower
       * and still worth having. `authorization.consumed_amount` is a running
       * total with no itemisation behind it, so when a commercial client asks
       * which invoices ate their two thousand five hundred dollars, the
       * answer had to be reconstructed by matching job ids and dates. Now it
       * is a join.
       */
      authorizationId: ceiling?.id ?? null,
      status: "open",
      issuedOn,
      dueOn: input.dueOn ?? null,
      subtotal: m.toString(computed.totals.subtotal),
      discountTotal: m.toString(computed.totals.discountTotal),
      taxTotal: m.toString(computed.totals.taxTotal),
      total: m.toString(computed.totals.total),
      balance: m.toString(computed.totals.total),
      memo: input.memo ?? null,
      ...provenance(input.externalRef),
    }).returning();

    /**
     * A LINE THE CLIENT'S CARD DOES NOT PRICE IS SOMEBODY'S PROBLEM BEFORE
     * IT IS THE CLIENT'S.
     *
     * Not a refusal: an out of scope item genuinely can be agreed by phone,
     * and blocking the invoice would have somebody delete the line to get
     * past it. Raised as an obligation instead, which is this product's one
     * primitive for work a person owes, so it appears on the deadlines list
     * beside every other approaching thing rather than in a log nobody
     * opens.
     *
     * The alternative, which is what every system does, is to invoice at
     * list and find out when the client rejects it: a month of somebody's
     * time to re-bill and a conversation about whether we read the
     * agreement.
     */
    if (uncovered.length > 0) {
      await obligations.raise(tx, ctx.actor.organizationId, {
        kind: "contract.price_not_on_card",
        entityType: "invoice",
        entityId: invoice!.id,
        dueAt: new Date(),
        consequence:
          `${uncovered.length === 1 ? "An item is" : `${uncovered.length} items are`} `
          + `not on this customer's rate card (${uncovered.slice(0, 3).join(", ")}), `
          + "so they are priced at our list. Agree a price before this goes out.",
      });
    }

    /**
     * The link the schema has always had a column for and nothing wrote.
     * Without it, an invoice line that was free under a plan and one that
     * was free because we got it wrong are the same row, and the API
     * contract has promised a `coverageSource` on every line since it was
     * written.
     */
    const entitlementId = input.jobId ? await entitlementIdFor(tx, input.jobId) : null;

    await tx.insert(schema.invoiceLine).values(resolved.map((r, i) => ({
      organizationId: ctx.actor.organizationId,
      invoiceId: invoice!.id,
      /**
       * A line that explicitly says the customer is paying does not carry
       * the job's coverage, so the document does not later claim a
       * chargeable extra was covered by a warranty.
       */
      entitlementId: r.coverageSource === "customer" || r.origin === "manual" ? null : entitlementId,
      origin: r.origin,
      sortOrder: i,
      name: r.name,
      description: r.description,
      quantity: r.quantity,
      unitPrice: m.toString(r.unitPrice),
      unitCost: r.unitCost ? m.toString(r.unitCost) : null,
      discountAmount: m.toString(r.discountAmount),
      taxable: r.taxable,
      taxRate: r.taxRate,
      taxAmount: m.toString(computed.lines[i]!.taxAmount),
      lineTotal: m.toString(computed.lines[i]!.lineTotal),
      costCode: r.costCode,
      priceBookItemVersionId: r.versionId,
    })));

    /**
     * Dated by the issue date, and still an append: a back-dated posting is a
     * new balanced pair on an earlier day, never an edit to anything already
     * in the ledger. `writePosting` refuses it if that day is in a closed
     * period.
     */
    await writePosting(tx, ctx, ledger.postInvoice({
      invoiceId: invoice!.id,
      occurredAt: history.postingInstant(issuedOn, admitted.timeZone, now),
      totals: computed.totals,
      customerId: input.customerId,
      jobId: input.jobId,
    }));

    if (input.jobId) {
      await tx.update(schema.job)
        .set({ status: "invoiced", total: m.toString(computed.totals.total), updatedAt: new Date() })
        .where(eq(schema.job.id, input.jobId));
    }

    /**
     * Consumed once the invoice exists, so a second invoice on the same job
     * knows what the first one used. An increment rather than a computed
     * write, so two raised at the same moment cannot both read three hundred
     * and both write six hundred.
     */
    if (ceiling) {
      await commercial.consume(tx, {
        authorizationId: ceiling.id,
        terms: ceiling.terms,
        amount: computed.totals.total,
      });
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "invoice.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "invoice", entityId: invoice!.id,
      });
    }

    /**
     * BILLING EMITTED NOTHING, AT ALL.
     *
     * The workflow builder offered "when an invoice is paid" and "when an
     * invoice is sent" and this module never emitted a domain event in its
     * life. A company automating a thank-you text on payment got a workflow
     * that saved, enabled, and never fired, and nothing logs a subscription
     * that matches nothing because matching nothing is what a quiet week
     * looks like.
     */
    /**
     * NOT FOR HISTORY. An invoice from 2019 being recorded is not an invoice
     * being issued, and a workflow that sends "your invoice is ready" on this
     * event would send ten years of them on the day of a migration. The
     * audit line below still records it, marked as history.
     */
    if (!admitted.historical) {
      await emit(tx, ctx, {
        name: "invoice.issued", entityType: "invoice", entityId: invoice!.id,
        payload: {
          invoiceId: invoice!.id,
          customerId: invoice!.customerId,
          total: computed.totals.total ? m.toString(computed.totals.total) : "0",
          ...(input.jobId ? { jobId: input.jobId } : {}),
        },
      });
    }

    await audit(tx, ctx, "invoice.created", "invoice", invoice!.id, null,
      admitted.historical ? { ...invoice!, historical: true } : invoice!);
    return loadInvoice(tx, ctx, invoice!.id);
  });
}

/**
 * Loading an invoice with its lines, INSIDE a caller's transaction.
 *
 * Separate from `get` on purpose. `get` opens its own transaction, and calling
 * it from inside `create` opens a second one on a different connection that
 * cannot see the uncommitted insert. The first version of this file did
 * exactly that and the end to end test failed with "Invoice not found" on an
 * invoice it had just created.
 *
 * The rule that falls out of it: a service function never calls another
 * service function's public entry point from inside a transaction. It calls a
 * loader like this one, which takes the transaction it is already in.
 */
async function loadInvoice(tx: Database, ctx: ServiceContext, id: string) {
  const [invoice] = await tx.select().from(schema.invoice)
    .where(eq(schema.invoice.id, id)).limit(1);
  if (!invoice) throw new NotFoundError("Invoice");

  /**
   * The coverage source comes back on every line, which the API contract has
   * promised since it was written and nothing populated. It is read through
   * the entitlement rather than copied onto the line, so one place decides
   * who is paying and the document cannot disagree with the job.
   */
  const lines = await tx.select({
    line: schema.invoiceLine,
    coverageSource: schema.entitlement.source,
  })
    .from(schema.invoiceLine)
    .leftJoin(schema.entitlement, eq(schema.entitlement.id, schema.invoiceLine.entitlementId))
    .where(eq(schema.invoiceLine.invoiceId, id))
    .orderBy(schema.invoiceLine.sortOrder);

  return {
    ...clean(ctx, "invoice", invoice),
    lines: lines.map((l) => ({
      ...clean(ctx, "invoiceLine", l.line),
      coverageSource: l.coverageSource ?? null,
    })),
  };
}

export async function get(ctx: ServiceContext, input: z.infer<typeof getInvoice.input>) {
  return guardedRead(ctx, "invoice:read", (tx) => loadInvoice(tx, ctx, input.id));
}

export async function list(ctx: ServiceContext, input: z.infer<typeof listInvoices.input>) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);
    const rows = await tx
      .select({ invoice: schema.invoice, customerName: schema.customer.name })
      .from(schema.invoice)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
      .where(and(
        // A technician sees invoices for work they did, not the company's
        // receivables. See services/scope.ts.
        invoiceScopeFilter(scopeOf(ctx, "invoice"), ctx.actor),
        input.status ? inArray(schema.invoice.status, input.status) : undefined,
        input.customerId ? eq(schema.invoice.customerId, input.customerId) : undefined,
        input.payerCustomerId ? eq(schema.invoice.payerCustomerId, input.payerCustomerId) : undefined,
        input.jobId ? eq(schema.invoice.jobId, input.jobId) : undefined,
        byExternal(schema.invoice, input),
        cursor ? lt(schema.invoice.createdAt, new Date(cursor)) : undefined,
      ))
      .orderBy(desc(schema.invoice.createdAt))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.invoice.createdAt.toISOString());
    return {
      ...page,
      data: page.data.map((r) => ({ ...clean(ctx, "invoice", r.invoice), customerName: r.customerName })),
    };
  });
}

/**
 * Recording a payment.
 *
 * Allocation is the part that decides whether a migration and a month end
 * both reconcile. A payment can span invoices and an invoice can take many
 * payments, and the allocations are what connect them. Left unspecified, the
 * payment is applied oldest balance first, which is what a bookkeeper does by
 * hand and what a customer expects.
 *
 * "OLDEST" HAS TO BE A TOTAL ORDER, and it was not. This ordered by issue
 * date alone, and a company invoicing four jobs in one morning gives four
 * invoices the same issue date: Postgres then returns them in whatever order
 * the heap holds, and a customer paying part of what they owe has the money
 * land on an arbitrary one of them. The comment above said oldest first and
 * the behaviour was "whichever", which is worse than an admitted arbitrary
 * rule because the statements it produces look deliberate.
 *
 * The tie breaks are below, and the first of them is the due date rather
 * than the issue date. That is the order the aging report buckets by and the
 * order the customer is chased in, so it is the one a part payment should
 * clear.
 */
export async function pay(ctx: ServiceContext, input: z.infer<typeof recordPayment.input>) {
  return guardedWrite(ctx, "payment:collect", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "payment"),
        )).limit(1);
      if (seen?.entityId) {
        const [existing] = await tx.select().from(schema.payment).where(eq(schema.payment.id, seen.entityId)).limit(1);
        if (existing) {
          const allocations = await tx.select().from(schema.paymentAllocation)
            .where(eq(schema.paymentAllocation.paymentId, existing.id));
          return {
            id: existing.id,
            amount: existing.amount,
            allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
            unappliedAmount: m.toString(unappliedOf(existing, allocations)),
            ledgerTransactionId: "",
          };
        }
      }
    }

    /**
     * WHEN THE MONEY ARRIVED, and the ledger now agrees. `receivedAt` has
     * always been accepted and stored on the payment, and the posting
     * ignored it and used the wall clock, so a cheque received in March and
     * keyed in April was March on the payment and April in the books. Both
     * now say March, and saying March needs the same authority as any other
     * business date (see services/history.ts).
     */
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    const admitted = input.receivedAt
      ? await admitInstant(tx, ctx, receivedAt, "receivedAt")
      : { historical: false };

    const amount = usd(input.amount);
    const tip = usd(input.tipAmount);
    const fee = usd(input.feeAmount ?? "0");
    const surcharge = usd(input.surchargeAmount ?? "0");

    const allocations = input.allocations?.map((a) => ({ invoiceId: a.invoiceId, amount: usd(a.amount) })) ?? [];

    /**
     * OMITTED AND EMPTY ARE DIFFERENT REQUESTS.
     *
     * Omitted means "apply it the way a bookkeeper would", oldest balance
     * first. An empty list means "apply it to nothing": a deposit on work not
     * started, or a customer paying ahead. Both used to mean oldest first, so
     * a deposit taken last week for next month's job silently paid an
     * invoice from 2021, and there was no way to record money held for a
     * customer at all. Whatever is not applied is held as a liability (see
     * `postPayment`) until it is applied or given back.
     */
    if (input.allocations === undefined) {
      /**
       * Oldest balance first, as a TOTAL order: most overdue, then oldest
       * issued, then by invoice number. The number is the last tie break
       * because it is sequential and it is the thing on the statement, so
       * two invoices from the same morning clear in the order the customer
       * can see. An invoice with no due date sorts last: it is not overdue
       * because nobody has said when it is due.
       */
      const open = await tx.select().from(schema.invoice)
        .where(and(
          eq(schema.invoice.customerId, input.customerId),
          inArray(schema.invoice.status, ["open", "partially_paid"]),
        ))
        .orderBy(
          sql`${schema.invoice.dueOn} asc nulls last`,
          asc(schema.invoice.issuedOn),
          asc(schema.invoice.number),
        );

      let remaining = amount;
      for (const invoice of open) {
        if (!m.isPositive(remaining)) break;
        const balance = usd(invoice.balance);
        const applied = m.compare(remaining, balance) < 0 ? remaining : balance;
        if (m.isPositive(applied)) {
          allocations.push({ invoiceId: invoice.id, amount: applied });
          remaining = m.subtract(remaining, applied);
        }
      }
    }

    const allocatedTotal = m.sum(allocations.map((a) => a.amount), "USD");
    if (m.compare(allocatedTotal, amount) > 0) {
      throw new ConflictError(
        `Allocations total ${m.toString(allocatedTotal)} but the payment is ${m.toString(amount)}`,
      );
    }

    await assertUnclaimed(tx, "payment", input.externalRef);
    const [payment] = await tx.insert(schema.payment).values({
      organizationId: ctx.actor.organizationId,
      ...provenance(input.externalRef),
      customerId: input.customerId,
      method: input.method,
      status: "succeeded",
      amount: m.toString(amount),
      tipAmount: m.toString(tip),
      feeAmount: m.toString(fee),
      surchargeAmount: m.toString(surcharge),
      receivedAt,
      checkNumber: input.checkNumber ?? null,
      notes: input.notes ?? null,
      processorPaymentId: input.processorPaymentId ?? null,
      idempotencyKey: ctx.idempotencyKey ?? `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }).returning();

    /** Invoices this payment took to zero, carried on the payment event. */
    const settled = await allocate(tx, ctx, {
      paymentId: payment!.id, customerId: input.customerId, allocations, announce: !admitted.historical,
    });

    /**
     * THE FEE IS A LEDGER LEG, not a note on the payment row.
     *
     * `postPayment` has taken a `processingFee` since it was written and
     * debits it to an expense account, so cash goes up by what actually
     * landed in the bank and the fee is an expense the company can see. This
     * call passed neither it nor the surcharge, so both legs were always
     * zero: the books said the full amount reached the bank, which is wrong
     * by the fee on every card payment ever taken here.
     */
    const transactionId = await writePosting(tx, ctx, ledger.postPayment({
      paymentId: payment!.id,
      occurredAt: receivedAt,
      appliedAmount: allocatedTotal,
      unappliedAmount: m.subtract(amount, allocatedTotal),
      tipAmount: tip,
      surchargeAmount: surcharge,
      processingFee: fee,
      customerId: input.customerId,
    }));

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "payment.record",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "payment", entityId: payment!.id,
      });
    }

    /**
     * Not for history either. "Thanks for your payment" for a cheque from
     * 2021 is the text a migration must never send.
     */
    if (!admitted.historical) await emit(tx, ctx, {
      name: "payment.received", entityType: "payment", entityId: payment!.id,
      payload: {
        paymentId: payment!.id,
        customerId: input.customerId,
        amount: m.toString(amount),
        method: input.method,
        /** Which invoices this cleared, so a step does not have to go and look. */
        settledInvoiceIds: settled,
      },
    });

    await audit(tx, ctx, "payment.recorded", "payment", payment!.id, null,
      admitted.historical ? { ...payment!, historical: true } : payment!);

    return {
      id: payment!.id,
      amount: m.toString(amount),
      allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: m.toString(a.amount) })),
      unappliedAmount: m.toString(m.subtract(amount, allocatedTotal)),
      ledgerTransactionId: transactionId,
    };
  });
}

/**
 * What of a payment is still held for the customer: what arrived, less what
 * was applied, less what was given back. Never below zero, because a
 * processor refund of applied money moves the receivable rather than the
 * credit.
 */
export function unappliedOf(
  payment: { amount: string; refundedAmount: string },
  allocations: Array<{ amount: string }>,
): m.Money {
  const left = m.subtract(
    m.subtract(usd(payment.amount), m.sum(allocations.map((a) => usd(a.amount)), "USD")),
    usd(payment.refundedAmount),
  );
  return m.isNegative(left) ? usd("0") : left;
}

/**
 * Applying money a customer paid earlier to invoices now.
 *
 * Never more than the payment still holds, never more than an invoice owes,
 * and only to that customer's open invoices: an unapplied credit applied to
 * somebody else's invoice is a transfer between customers, which is a
 * different conversation. Posted today, because the application happens
 * today; the cash arrived when the payment did.
 */
export async function applyPayment(
  ctx: ServiceContext,
  input: { id: string; allocations: Array<{ invoiceId: string; amount: string }> },
) {
  return guardedWrite(ctx, "payment:collect", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "payment_application"),
        )).limit(1);
      if (seen?.entityId) return loadPayment(tx, ctx, input.id);
    }

    const [payment] = await tx.select().from(schema.payment)
      .where(eq(schema.payment.id, input.id)).limit(1);
    if (!payment) throw new NotFoundError("Payment");
    const existing = await tx.select({ amount: schema.paymentAllocation.amount })
      .from(schema.paymentAllocation).where(eq(schema.paymentAllocation.paymentId, payment.id));

    const held = unappliedOf(payment, existing);
    const allocations = input.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: usd(a.amount) }));
    const total = m.sum(allocations.map((a) => a.amount), "USD");
    if (!m.isPositive(total) || allocations.some((a) => !m.isPositive(a.amount))) {
      throw new UnprocessableError("Each allocation must be a positive amount", [{
        path: "allocations", message: "Apply a positive amount to each invoice.",
      }]);
    }
    if (m.compare(total, held) > 0) {
      throw new ConflictError(`This payment holds ${m.toString(held)} unapplied, and ${m.toString(total)} was asked for.`);
    }

    for (const allocation of allocations) {
      const [invoice] = await tx.select().from(schema.invoice)
        .where(eq(schema.invoice.id, allocation.invoiceId)).limit(1);
      if (!invoice) throw new NotFoundError("Invoice");
      if ((invoice.payerCustomerId ?? invoice.customerId) !== payment.customerId
        && invoice.customerId !== payment.customerId) {
        throw new ConflictError(`Invoice ${invoice.number} is not this customer's.`);
      }
      if (invoice.status !== "open" && invoice.status !== "partially_paid") {
        throw new ConflictError(`Invoice ${invoice.number} is ${invoice.status.replace("_", " ")} and takes no payment.`);
      }
      if (m.compare(allocation.amount, usd(invoice.balance)) > 0) {
        throw new ConflictError(`Invoice ${invoice.number} owes ${invoice.balance}, less than ${m.toString(allocation.amount)}.`);
      }
    }

    await allocate(tx, ctx, {
      paymentId: payment.id, customerId: payment.customerId, allocations, announce: true,
    });
    await writePosting(tx, ctx, ledger.postCreditApplication({
      paymentId: payment.id, occurredAt: new Date(), amount: total, customerId: payment.customerId,
    }));

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "payment.apply",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "payment_application", entityId: payment.id,
      });
    }
    await audit(tx, ctx, "payment.applied", "payment", payment.id,
      { unapplied: m.toString(held) },
      { allocations: input.allocations, unapplied: m.toString(m.subtract(held, total)) });
    return loadPayment(tx, ctx, payment.id);
  });
}

/**
 * Recording a refund paid by hand.
 *
 * Out of held money first, because returning a credit nobody used reverses
 * nothing that was ever owed. Beyond that it reopens what the payment paid,
 * newest allocation first, as NEGATIVE allocation rows rather than edits to
 * the old ones: the allocations are the history of where this money went,
 * and that history now says it came back. The invoice's paid amount and
 * balance follow, so the cache agrees with the receivable the posting puts
 * back.
 *
 * A job already marked paid stays paid. Its lifecycle does not go
 * backwards, and the invoice is what now shows money owed.
 */
export async function recordRefund(
  ctx: ServiceContext,
  input: {
    id: string; amount: string; method: string; reason: string;
    refundedAt?: string | undefined; checkNumber?: string | undefined;
  },
) {
  return guardedWrite(ctx, "payment:refund", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "payment_refund"),
        )).limit(1);
      if (seen?.entityId) return loadPayment(tx, ctx, seen.entityId);
    }

    const refundedAt = input.refundedAt ? new Date(input.refundedAt) : new Date();
    if (input.refundedAt) await admitInstant(tx, ctx, refundedAt, "refundedAt");

    const [payment] = await tx.select().from(schema.payment)
      .where(eq(schema.payment.id, input.id)).limit(1);
    if (!payment) throw new NotFoundError("Payment");

    const amount = usd(input.amount);
    if (!m.isPositive(amount)) {
      throw new UnprocessableError("A refund is a positive amount", [{
        path: "amount", message: "Send how much went back, as a positive amount.",
      }]);
    }
    const left = m.subtract(usd(payment.amount), usd(payment.refundedAmount));
    if (m.compare(amount, left) > 0) {
      throw new ConflictError(`Only ${m.toString(left)} of that payment is left to refund.`);
    }

    const { fromHeld, after } = await reverseForRefund(tx, ctx, payment, amount, refundedAt);

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "payment.refund_recorded",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "payment_refund", entityId: payment.id,
      });
    }
    await audit(tx, ctx, "payment.refund_recorded", "payment", payment.id, payment, {
      ...after!, refund: {
        amount: m.toString(amount), fromHeld: m.toString(fromHeld), method: input.method,
        refundedAt, checkNumber: input.checkNumber ?? null, reason: input.reason,
      },
    });
    return loadPayment(tx, ctx, payment.id);
  });
}

/**
 * What a refund does to the books, whoever reports it.
 *
 * Shared by a refund recorded by hand (`recordRefund`) and one the card
 * processor reports (`payments.receive`), so the two cannot disagree about
 * which invoices reopen or what the posting says. Out of held money first,
 * then newest allocation first as negative allocation rows; the invoices'
 * paid amount and balance follow; one `refund` posting dated `refundedAt`;
 * and the payment's refunded total and status move with it. A void or
 * written off invoice is refused rather than reopened, because the money it
 * received cannot go back onto a receivable that no longer exists.
 *
 * The caller has already checked `amount` against what is left to refund.
 */
export async function reverseForRefund(
  tx: Database, ctx: ServiceContext, payment: typeof schema.payment.$inferSelect,
  amount: m.Money, refundedAt: Date,
): Promise<{ fromHeld: m.Money; after: typeof schema.payment.$inferSelect }> {
  const allocations = await tx.select().from(schema.paymentAllocation)
    .where(eq(schema.paymentAllocation.paymentId, payment.id))
    .orderBy(desc(schema.paymentAllocation.createdAt));
  const held = unappliedOf(payment, allocations);
  const fromHeld = m.compare(amount, held) <= 0 ? amount : held;
  let fromApplied = m.subtract(amount, fromHeld);

  /** What is still applied to each invoice, newest first. */
  const netByInvoice = new Map<string, m.Money>();
  for (const a of [...allocations].reverse()) {
    netByInvoice.set(a.invoiceId, m.add(netByInvoice.get(a.invoiceId) ?? usd("0"), usd(a.amount)));
  }
  const order = [...new Set(allocations.map((a) => a.invoiceId))];

  for (const invoiceId of order) {
    if (!m.isPositive(fromApplied)) break;
    const applied = netByInvoice.get(invoiceId) ?? usd("0");
    if (!m.isPositive(applied)) continue;
    const take = m.compare(fromApplied, applied) <= 0 ? fromApplied : applied;

    const [invoice] = await tx.select().from(schema.invoice)
      .where(eq(schema.invoice.id, invoiceId)).limit(1);
    if (!invoice) throw new NotFoundError("Invoice");
    if (invoice.status === "void" || invoice.status === "written_off") {
      throw new ConflictError(
        `Invoice ${invoice.number} is ${invoice.status.replace("_", " ")}, so the money this payment put on it cannot be reopened there.`,
      );
    }
    await tx.insert(schema.paymentAllocation).values({
      organizationId: ctx.actor.organizationId,
      paymentId: payment.id, invoiceId, amount: m.toString(m.negate(take)),
    });
    const paid = m.subtract(usd(invoice.amountPaid), take);
    const balance = m.add(usd(invoice.balance), take);
    await tx.update(schema.invoice).set({
      amountPaid: m.toString(paid),
      balance: m.toString(balance),
      status: m.isPositive(paid) ? "partially_paid" : "open",
      updatedAt: new Date(),
    }).where(eq(schema.invoice.id, invoiceId));
    fromApplied = m.subtract(fromApplied, take);
  }

  await writePosting(tx, ctx, ledger.postRefund({
    refundId: payment.id, occurredAt: refundedAt, amount, heldAmount: fromHeld,
    customerId: payment.customerId,
  }));

  const refunded = m.add(usd(payment.refundedAmount), amount);
  const [after] = await tx.update(schema.payment).set({
    refundedAmount: m.toString(refunded),
    status: m.compare(refunded, usd(payment.amount)) >= 0 ? "refunded" : "partially_refunded",
    updatedAt: new Date(),
  }).where(eq(schema.payment.id, payment.id)).returning();
  return { fromHeld, after: after! };
}

/** A payment as the API returns it, inside a caller's transaction. */
export async function loadPayment(tx: Database, ctx: ServiceContext, id: string) {
  const [payment] = await tx.select().from(schema.payment).where(eq(schema.payment.id, id)).limit(1);
  if (!payment) throw new NotFoundError("Payment");
  const allocations = await tx.select({
    invoiceId: schema.paymentAllocation.invoiceId,
    amount: schema.paymentAllocation.amount,
  }).from(schema.paymentAllocation)
    .where(eq(schema.paymentAllocation.paymentId, id))
    .orderBy(asc(schema.paymentAllocation.createdAt));
  const { idempotencyKey: _key, ...rest } = payment;
  return {
    ...clean(ctx, "payment", rest),
    allocations,
    unappliedAmount: m.toString(unappliedOf(payment, allocations)),
  };
}

/**
 * Payments, newest received first.
 *
 * Cursor on the received instant and then the id, because a migration loads
 * hundreds of payments dated the same day and a cursor on the instant alone
 * would skip or repeat them at a page boundary.
 */
export async function pagePayments(ctx: ServiceContext, input: z.infer<typeof listPayments_.input>) {
  return guardedRead(ctx, "payment:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);
    const [at, id] = cursor ? cursor.split("|") : [];
    const rows = await tx.select().from(schema.payment)
      .where(and(
        input.customerId ? eq(schema.payment.customerId, input.customerId) : undefined,
        input.method ? eq(schema.payment.method, input.method) : undefined,
        input.status ? eq(schema.payment.status, input.status as never) : undefined,
        input.receivedFrom ? gte(schema.payment.receivedAt, new Date(input.receivedFrom)) : undefined,
        input.receivedTo ? lt(schema.payment.receivedAt, new Date(input.receivedTo)) : undefined,
        input.invoiceId
          ? inArray(schema.payment.id, tx.select({ id: schema.paymentAllocation.paymentId })
            .from(schema.paymentAllocation)
            .where(eq(schema.paymentAllocation.invoiceId, input.invoiceId)))
          : undefined,
        byExternal(schema.payment, input),
        at && id
          ? sql`(${schema.payment.receivedAt}, ${schema.payment.id}) < (${new Date(at).toISOString()}::timestamptz, ${id}::uuid)`
          : undefined,
      ))
      .orderBy(desc(schema.payment.receivedAt), desc(schema.payment.id))
      .limit(input.unappliedOnly ? 1000 : input.limit + 1);

    const ids = rows.map((r) => r.id);
    const allocations = ids.length
      ? await tx.select({
          paymentId: schema.paymentAllocation.paymentId,
          invoiceId: schema.paymentAllocation.invoiceId,
          amount: schema.paymentAllocation.amount,
        }).from(schema.paymentAllocation)
          .where(inArray(schema.paymentAllocation.paymentId, ids))
          .orderBy(asc(schema.paymentAllocation.createdAt))
      : [];

    const shaped = rows.map((payment) => {
      const own = allocations.filter((a) => a.paymentId === payment.id)
        .map((a) => ({ invoiceId: a.invoiceId, amount: a.amount }));
      const { idempotencyKey: _key, ...rest } = payment;
      return {
        row: payment,
        out: {
          ...clean(ctx, "payment", rest),
          allocations: own,
          unappliedAmount: m.toString(unappliedOf(payment, own)),
        },
      };
    });
    /**
     * Held money is computed, not stored, so "only what still holds
     * something" is a filter over the computed figure, bounded so a company
     * with a decade of payments cannot ask for all of them at once.
     */
    const kept = input.unappliedOnly
      ? shaped.filter((p) => m.isPositive(usd(p.out.unappliedAmount))).slice(0, input.limit + 1)
      : shaped;
    const page = paginate(kept, input.limit, (p) => `${p.row.receivedAt.toISOString()}|${p.row.id}`);
    return { ...page, data: page.data.map((p) => p.out) };
  });
}

/**
 * Applying money to invoices, for a payment as it arrives and for one applied
 * later. One loop, so the two cannot disagree about what "paid" means.
 *
 * Returns the invoices taken to zero.
 */
async function allocate(
  tx: Database, ctx: ServiceContext,
  input: {
    paymentId: string; customerId: string;
    allocations: Array<{ invoiceId: string; amount: m.Money }>;
    /** False for history, which is recorded and not announced. */
    announce: boolean;
  },
): Promise<string[]> {
  const settled: string[] = [];
  for (const allocation of input.allocations) {
    await tx.insert(schema.paymentAllocation).values({
      organizationId: ctx.actor.organizationId,
      paymentId: input.paymentId,
      invoiceId: allocation.invoiceId,
      amount: m.toString(allocation.amount),
    });

    const [invoice] = await tx.select().from(schema.invoice)
      .where(eq(schema.invoice.id, allocation.invoiceId)).limit(1);
    if (!invoice) throw new NotFoundError("Invoice");

    const paid = m.add(usd(invoice.amountPaid), allocation.amount);
    const balance = m.subtract(usd(invoice.total), paid);

    await tx.update(schema.invoice).set({
      amountPaid: m.toString(paid),
      balance: m.toString(balance),
      status: m.isZero(balance) || m.isNegative(balance) ? "paid" : "partially_paid",
      updatedAt: new Date(),
    }).where(eq(schema.invoice.id, allocation.invoiceId));

    if (invoice.jobId && (m.isZero(balance) || m.isNegative(balance))) {
      await tx.update(schema.job).set({ status: "paid", updatedAt: new Date() })
        .where(eq(schema.job.id, invoice.jobId));
    }

    /**
     * PAID IN FULL IS THE EVENT, not "a payment touched this invoice".
     *
     * A part payment on a thousand dollar invoice is not the moment to
     * send a thank you, and a workflow author writing "when an invoice is
     * paid" means the balance reached zero. `payment.received` is the other
     * event, for the automations that do care about every payment.
     */
    if (m.isZero(balance) || m.isNegative(balance)) {
      settled.push(allocation.invoiceId);
      if (input.announce) await emit(tx, ctx, {
        name: "invoice.paid", entityType: "invoice", entityId: allocation.invoiceId,
        payload: {
          invoiceId: allocation.invoiceId,
          customerId: input.customerId,
          total: m.toString(usd(invoice.total)),
          ...(invoice.jobId ? { jobId: invoice.jobId } : {}),
        },
        previous: { balance: invoice.balance, status: invoice.status },
      });
    }
  }
  return settled;
}

/**
 * AR aging, grouped by PAYER.
 *
 * On a commercial book the payer is a warranty company, a carrier or a
 * facilities network rather than the customer, and aging by customer scatters
 * one slow payer across two hundred rows where nobody will see it.
 */
export async function arAging(ctx: ServiceContext, input: z.infer<typeof getArAging.input>) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);

    const rows = await tx.execute<{
      payer_id: string | null; payer_name: string;
      current: string; d1: string; d31: string; d61: string; d90: string; total: string;
    }>(sql`
      select
        coalesce(i.payer_customer_id, i.customer_id) as payer_id,
        coalesce(payer.name, cust.name) as payer_name,
        sum(case when ${sql.raw(`'${asOf}'::date`)} - i.due_on <= 0  then i.balance else 0 end) as current,
        sum(case when ${sql.raw(`'${asOf}'::date`)} - i.due_on between 1 and 30  then i.balance else 0 end) as d1,
        sum(case when ${sql.raw(`'${asOf}'::date`)} - i.due_on between 31 and 60 then i.balance else 0 end) as d31,
        sum(case when ${sql.raw(`'${asOf}'::date`)} - i.due_on between 61 and 90 then i.balance else 0 end) as d61,
        sum(case when ${sql.raw(`'${asOf}'::date`)} - i.due_on > 90 then i.balance else 0 end) as d90,
        sum(i.balance) as total
      from public.invoice i
      join public.customer cust on cust.id = i.customer_id
      left join public.customer payer on payer.id = i.payer_customer_id
      where i.status in ('open', 'partially_paid')
      group by 1, 2
      having sum(i.balance) <> 0
      order by total desc
    `);

    const buckets = rows.map((r) => ({
      payerId: r.payer_id,
      payerName: r.payer_name,
      current: r.current, days1to30: r.d1, days31to60: r.d31,
      days61to90: r.d61, over90: r.d90, total: r.total,
    }));

    return {
      asOf,
      buckets,
      total: m.toString(m.sum(buckets.map((b) => usd(b.total)), "USD")),
    };
  });
}

/**
 * What kind of charge a line is, for the purpose of who pays for it.
 *
 * Inferred from the cost code where there is one and from the name where
 * there is not, because an invoice line has never carried a kind and adding
 * one to the contract would break every existing caller. A line we cannot
 * classify is the CUSTOMER's, deliberately: guessing the other way means a
 * line billed to nobody, and a line billed to nobody is revenue that
 * silently disappears.
 */
export function chargeKindOf(name: string, costCode: string | null): coverage.ChargeKind {
  const text = `${costCode ?? ""} ${name}`.toLowerCase();
  if (/\btrip\b|\bdispatch\b|\bcall ?out\b|\bdiagnostic\b|\btravel\b/.test(text)) return "trip";
  if (/\blabou?r\b|\bhour\b|\btech\b|\binstall\b|\bservice call\b/.test(text)) return "labour";
  if (/\bpart\b|\bmaterial\b|\bequipment\b|\bunit\b|\bfilter\b|\bmotor\b|\bcapacitor\b/.test(text)) {
    return "parts";
  }
  return "other";
}

/** The entitlement row this job resolved to, for linking lines to it. */
async function entitlementIdFor(tx: Database, jobId: string): Promise<string | null> {
  const [row] = await tx.select({ id: schema.entitlement.id }).from(schema.entitlement)
    .where(eq(schema.entitlement.jobId, jobId)).limit(1);
  return row?.id ?? null;
}

/**
 * THE TWO WAYS AN INVOICE ENDS WITHOUT BEING PAID.
 *
 * `invoice_status` has carried `void` and `written_off` since it was written,
 * the contract publishes both, `invoice:writeoff` is a permission in the
 * catalogue, and `ledger.postWriteOff` was written and tested. Nothing could
 * reach any of it: no route, no service, no path. `invoice.voided_at` was a
 * column nothing wrote.
 *
 * So a company had exactly one way to deal with an invoice that was never
 * going to be paid, which was to leave it open forever. Receivables aged
 * past a year, the AR report kept counting money that did not exist, and the
 * only workaround was editing the database.
 *
 * VOID AND WRITE OFF ARE DIFFERENT and the difference is the whole reason
 * both exist. A write off says the money is owed and will not arrive: the
 * receivable goes, the revenue stays, and a bad debt expense appears beside
 * it. A void says the invoice should never have existed: the revenue was
 * never earned and the tax was never collected, so the original posting is
 * reversed line for line. Using the wrong one leaves either revenue the
 * company never earned or an expense it never suffered on a set of books a
 * tax return is built from.
 */
export async function voidInvoice(
  ctx: ServiceContext, input: { id: string; reason: string },
) {
  return guardedWrite(ctx, "invoice:void", async (tx) => {
    const invoice = await loadForClosing(tx, ctx, input.id);

    /**
     * A paid invoice cannot be voided. Money arrived against it, and
     * pretending it never existed strands the payment with nothing to
     * allocate against. That is a refund, which is a different posting and a
     * different conversation with the customer.
     */
    if (m.isPositive(m.money(invoice.amountPaid, "USD"))) {
      throw new ConflictError(
        `Invoice ${invoice.number} has ${invoice.amountPaid} paid against it. `
        + "Refund the payment first, or write the balance off instead.",
      );
    }

    await writePosting(tx, ctx, ledger.postVoid({
      invoiceId: invoice.id,
      occurredAt: new Date(),
      totals: {
        subtotal: m.money(invoice.subtotal, "USD"),
        discountTotal: m.money(invoice.discountTotal, "USD"),
        taxTotal: m.money(invoice.taxTotal, "USD"),
        total: m.money(invoice.total, "USD"),
      },
      customerId: invoice.customerId,
      ...(invoice.jobId ? { jobId: invoice.jobId } : {}),
    }));

    await tx.update(schema.invoice).set({
      status: "void",
      voidedAt: new Date(),
      /**
       * The balance goes to zero because nothing is owed any more. Leaving
       * the old figure there is what makes an AR report keep counting an
       * invoice nobody is chasing.
       */
      balance: "0",
      updatedAt: new Date(),
    }).where(eq(schema.invoice.id, invoice.id));

    await audit(tx, ctx, "invoice.voided", "invoice", invoice.id,
      { status: invoice.status, balance: invoice.balance },
      { status: "void", reason: input.reason });

    return loadInvoice(tx, ctx, invoice.id);
  });
}

export async function writeOff(
  ctx: ServiceContext, input: { id: string; reason: string },
) {
  return guardedWrite(ctx, "invoice:writeoff", async (tx) => {
    const invoice = await loadForClosing(tx, ctx, input.id);

    const balance = m.money(invoice.balance, "USD");
    if (!m.isPositive(balance)) {
      /**
       * Writing off nothing posts a zero pair to the ledger and marks a paid
       * invoice as a bad debt. Both are wrong, and the second one is the kind
       * of wrong an accountant finds a year later.
       */
      throw new ConflictError(
        `Invoice ${invoice.number} has nothing outstanding. There is nothing to write off.`,
      );
    }

    /**
     * ONLY THE BALANCE, never the total. An invoice half paid and then
     * written off loses the unpaid half, and writing off the whole total
     * would remove a receivable that was already settled in cash.
     */
    await writePosting(tx, ctx, ledger.postWriteOff({
      invoiceId: invoice.id,
      occurredAt: new Date(),
      amount: balance,
      customerId: invoice.customerId,
    }));

    await tx.update(schema.invoice).set({
      status: "written_off",
      balance: "0",
      updatedAt: new Date(),
    }).where(eq(schema.invoice.id, invoice.id));

    await audit(tx, ctx, "invoice.written_off", "invoice", invoice.id,
      { status: invoice.status, balance: invoice.balance },
      { status: "written_off", amount: m.toString(balance), reason: input.reason });

    return loadInvoice(tx, ctx, invoice.id);
  });
}

/**
 * The invoice, and a refusal when it is already finished.
 *
 * Both terminal states are absorbing. Voiding a written off invoice, or
 * writing off a void one, posts a second entry against a receivable that is
 * already gone and takes the ledger out of agreement with itself.
 */
async function loadForClosing(
  tx: Database, ctx: ServiceContext, id: string,
): Promise<typeof schema.invoice.$inferSelect> {
  const [invoice] = await tx.select().from(schema.invoice)
    .where(and(eq(schema.invoice.id, id), isNull(schema.invoice.deletedAt)))
    .limit(1);
  if (!invoice) throw new NotFoundError("Invoice");

  if (invoice.status === "void" || invoice.status === "written_off") {
    throw new ConflictError(
      `Invoice ${invoice.number} is already ${invoice.status.replace("_", " ")}.`,
    );
  }
  if (invoice.status === "draft") {
    /**
     * A draft has never been posted to the ledger, so there is nothing to
     * reverse and nothing to lose. Deleting it is the right action and this
     * is not it.
     */
    throw new ConflictError(
      `Invoice ${invoice.number} is still a draft. Delete it rather than voiding it.`,
    );
  }
  return invoice;
}

/* ------------------------------------------------- reading payments back */

/**
 * `payment:read` WAS GRANTED TO ROLES AND CHECKED BY NOTHING.
 *
 * This file takes payments, allocates them oldest balance first, and posts
 * every one to the ledger. An invoice carries the payments against itself, so
 * "has this bill been paid" was answerable. "What came in this week" was not.
 *
 * That is the question a company asks every single morning, and the one
 * reconciling a bank deposit against the day's takings asks it per method:
 * cash and cheque sit in a drawer until somebody banks them, card settles
 * net of a fee two days later. Without this they went to the processor's own
 * dashboard, which does not know about the cheques.
 */

export interface PaymentView {
  id: string;
  customerId: string;
  method: string;
  status: string;
  currency: string;
  amount: string;
  /** What the processor kept. Zero for cash; never null, because null is unknown. */
  feeAmount: string;
  tipAmount: string;
  surchargeAmount: string;
  refundedAmount: string;
  /** Amount less what has gone back. What the company actually kept. */
  net: string;
  processor: string;
  processorPaymentId: string | null;
  checkNumber: string | null;
  receivedAt: string;
  /** Which invoices it paid and how much of each. */
  allocations: { invoiceId: string; invoiceNumber: number | null; amount: string }[];
}

export interface PaymentQuery {
  customerId?: string | undefined;
  invoiceId?: string | undefined;
  method?: string | undefined;
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

export async function listPayments(ctx: ServiceContext, input: PaymentQuery): Promise<{
  payments: PaymentView[];
  /** Totals for the window, which is what a day's banking is checked against. */
  totals: { gross: string; fees: string; refunded: string; net: string };
  /** Per method, because cash, cheque and card are banked differently. */
  byMethod: { method: string; count: number; gross: string; net: string }[];
}> {
  return guardedRead(ctx, "payment:read", async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

    /**
     * Filtering by invoice goes through the allocation table, because "what
     * paid this invoice" is a question about the relationship. A payment
     * split across three invoices is one payment, and matching it on a
     * column of the payment row would be impossible.
     */
    let onlyThese: string[] | null = null;
    if (input.invoiceId) {
      const links = await tx.select({ paymentId: schema.paymentAllocation.paymentId })
        .from(schema.paymentAllocation)
        .where(and(
          eq(schema.paymentAllocation.organizationId, ctx.actor.organizationId),
          eq(schema.paymentAllocation.invoiceId, input.invoiceId),
        ));
      onlyThese = [...new Set(links.map((l) => l.paymentId))];
      if (onlyThese.length === 0) {
        return {
          payments: [],
          totals: { gross: "0.0000", fees: "0.0000", refunded: "0.0000", net: "0.0000" },
          byMethod: [],
        };
      }
    }

    const rows = await tx.select().from(schema.payment)
      .where(and(
        eq(schema.payment.organizationId, ctx.actor.organizationId),
        /**
         * NO `isNull(deletedAt)` HERE, and a guard test is why.
         *
         * The first version filtered it, and nothing in this product soft
         * deletes a payment. It cannot: money that arrived is corrected by a
         * refund, which is a second recorded fact, never by making the first
         * one disappear. So the clause could never be the thing that decided,
         * which makes it a filter reading as protection that is not there.
         */
        onlyThese ? inArray(schema.payment.id, onlyThese) : undefined,
        input.customerId ? eq(schema.payment.customerId, input.customerId) : undefined,
        input.method ? eq(schema.payment.method, input.method as never) : undefined,
        input.status ? eq(schema.payment.status, input.status as never) : undefined,
        /**
         * Through the column operators rather than a raw template. A Date
         * interpolated into `sql` reaches the driver unencoded and the
         * request fails, so a date range on this read had never worked.
         */
        input.from ? gte(schema.payment.receivedAt, new Date(input.from)) : undefined,
        input.to ? lte(schema.payment.receivedAt, new Date(input.to)) : undefined,
      ))
      .orderBy(desc(schema.payment.receivedAt))
      .limit(limit);

    if (rows.length === 0) {
      return {
        payments: [],
        totals: { gross: "0.0000", fees: "0.0000", refunded: "0.0000", net: "0.0000" },
        byMethod: [],
      };
    }

    const allocations = await tx.select({
      paymentId: schema.paymentAllocation.paymentId,
      invoiceId: schema.paymentAllocation.invoiceId,
      amount: schema.paymentAllocation.amount,
      invoiceNumber: schema.invoice.number,
    }).from(schema.paymentAllocation)
      .leftJoin(schema.invoice, eq(schema.invoice.id, schema.paymentAllocation.invoiceId))
      .where(and(
        eq(schema.paymentAllocation.organizationId, ctx.actor.organizationId),
        inArray(schema.paymentAllocation.paymentId, rows.map((r) => r.id)),
      ));

    const byPayment = new Map<string, PaymentView["allocations"]>();
    for (const link of allocations) {
      const bucket = byPayment.get(link.paymentId) ?? [];
      bucket.push({
        invoiceId: link.invoiceId,
        invoiceNumber: link.invoiceNumber,
        amount: link.amount,
      });
      byPayment.set(link.paymentId, bucket);
    }

    let gross = m.money("0", "USD");
    let fees = m.money("0", "USD");
    let refunded = m.money("0", "USD");
    const methods = new Map<string, { count: number; gross: m.Money; net: m.Money }>();
    const payments: PaymentView[] = [];

    for (const row of rows) {
      const amount = m.money(row.amount, row.currency);
      const back = m.money(row.refundedAmount, row.currency);
      const net = m.subtract(amount, back);

      payments.push({
        id: row.id,
        customerId: row.customerId,
        method: row.method,
        status: row.status,
        currency: row.currency,
        amount: row.amount,
        feeAmount: row.feeAmount,
        tipAmount: row.tipAmount,
        surchargeAmount: row.surchargeAmount,
        refundedAmount: row.refundedAmount,
        net: m.toString(net),
        processor: row.processor,
        processorPaymentId: row.processorPaymentId,
        checkNumber: row.checkNumber,
        receivedAt: row.receivedAt.toISOString(),
        allocations: byPayment.get(row.id) ?? [],
      });

      /**
       * Totals in one currency only, and the rest left out of them rather
       * than added in. Summing across currencies produces a number that is
       * not money in any of them, and a company reconciling a day's banking
       * would check it against a bank line and never find the difference.
       */
      if (row.currency !== gross.currency) continue;
      gross = m.add(gross, amount);
      fees = m.add(fees, m.money(row.feeAmount, row.currency));
      refunded = m.add(refunded, back);

      const current = methods.get(row.method)
        ?? { count: 0, gross: m.money("0", row.currency), net: m.money("0", row.currency) };
      methods.set(row.method, {
        count: current.count + 1,
        gross: m.add(current.gross, amount),
        net: m.add(current.net, net),
      });
    }

    return {
      payments,
      totals: {
        gross: m.toString(gross),
        fees: m.toString(fees),
        refunded: m.toString(refunded),
        net: m.toString(m.subtract(gross, refunded)),
      },
      byMethod: [...methods]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([method, totals]) => ({
          method,
          count: totals.count,
          gross: m.toString(totals.gross),
          net: m.toString(totals.net),
        })),
    };
  });
}

/**
 * `GET /v1/payments`: a page of payments and the totals for the window.
 *
 * The page is `pagePayments`, which a migration reads back through by
 * cursor and by `externalRef`. The totals are `listPayments`, which a day's
 * banking is checked against. They answer one request because they arrived
 * as two routes on one path from two branches, and both answers were wanted.
 */
export const paymentReadHandlers = {
  listPayments: async (ctx: ServiceContext, input: z.infer<typeof listPayments_.input>) => {
    const page = await pagePayments(ctx, input);
    const summary = await listPayments(ctx, {
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      method: input.method,
      status: input.status,
      from: input.receivedFrom,
      /** `receivedTo` is exclusive and `to` is inclusive; a millisecond apart. */
      to: input.receivedTo
        ? new Date(new Date(input.receivedTo).getTime() - 1).toISOString()
        : undefined,
      limit: 500,
    });
    return { ...page, totals: summary.totals, byMethod: summary.byMethod };
  },
} as const;
