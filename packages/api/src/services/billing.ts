import { and, eq, desc, lt, inArray, sql, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m } from "@opentradesos/core";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
import { writePosting } from "./ledger";
import { nextNumber } from "./jobs";
import type { createInvoice, listInvoices, getInvoice, recordPayment, getArAging } from "../contracts/billing";

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
          isNull(schema.priceBookItemVersion.effectiveTo),
        ))
      : [];
    const byItem = new Map(versions.map((v) => [v.itemId, v]));

    const resolved = input.lines.map((line) => {
      const version = line.priceBookItemId ? byItem.get(line.priceBookItemId) : undefined;
      return {
        name: version?.name ?? line.name,
        description: line.description ?? null,
        quantity: line.quantity,
        unitPrice: usd(version?.price ?? line.unitPrice),
        unitCost: version?.cost ? usd(version.cost) : null,
        discountAmount: usd(line.discountAmount),
        taxable: version?.taxable ?? line.taxable,
        /** Resolved per jurisdiction in phase 5. Zero until then, honestly. */
        taxRate: "0",
        costCode: line.costCode ?? null,
        versionId: version?.versionId ?? null,
        coverageSource: line.coverageSource ?? null,
      };
    });

    const computed = ledger.computeInvoice(resolved.map((r) => ({
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      discountAmount: r.discountAmount,
      taxable: r.taxable,
      taxRate: r.taxRate,
    })));

    const number = await nextNumber(tx, ctx.actor.organizationId, "invoice");

    const [invoice] = await tx.insert(schema.invoice).values({
      organizationId: ctx.actor.organizationId,
      number,
      customerId: input.customerId,
      payerCustomerId: input.payerCustomerId ?? null,
      jobId: input.jobId ?? null,
      purchaseOrderNumber: input.purchaseOrderNumber ?? null,
      status: "open",
      issuedOn: new Date().toISOString().slice(0, 10),
      dueOn: input.dueOn ?? null,
      subtotal: m.toString(computed.totals.subtotal),
      discountTotal: m.toString(computed.totals.discountTotal),
      taxTotal: m.toString(computed.totals.taxTotal),
      total: m.toString(computed.totals.total),
      balance: m.toString(computed.totals.total),
      memo: input.memo ?? null,
    }).returning();

    await tx.insert(schema.invoiceLine).values(resolved.map((r, i) => ({
      organizationId: ctx.actor.organizationId,
      invoiceId: invoice!.id,
      origin: "job" as const,
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

    await writePosting(tx, ctx, ledger.postInvoice({
      invoiceId: invoice!.id,
      occurredAt: new Date(),
      totals: computed.totals,
      customerId: input.customerId,
      jobId: input.jobId,
    }));

    if (input.jobId) {
      await tx.update(schema.job)
        .set({ status: "invoiced", total: m.toString(computed.totals.total), updatedAt: new Date() })
        .where(eq(schema.job.id, input.jobId));
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "invoice.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "invoice", entityId: invoice!.id,
      });
    }

    await audit(tx, ctx, "invoice.created", "invoice", invoice!.id, null, invoice!);
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

  const lines = await tx.select().from(schema.invoiceLine)
    .where(eq(schema.invoiceLine.invoiceId, id))
    .orderBy(schema.invoiceLine.sortOrder);

  return {
    ...clean(ctx, "invoice", invoice),
    lines: lines.map((l) => clean(ctx, "invoiceLine", l)),
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
        input.status ? inArray(schema.invoice.status, input.status) : undefined,
        input.customerId ? eq(schema.invoice.customerId, input.customerId) : undefined,
        input.payerCustomerId ? eq(schema.invoice.payerCustomerId, input.payerCustomerId) : undefined,
        input.jobId ? eq(schema.invoice.jobId, input.jobId) : undefined,
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
            ledgerTransactionId: "",
          };
        }
      }
    }

    const amount = usd(input.amount);
    const tip = usd(input.tipAmount);

    const allocations = input.allocations?.map((a) => ({ invoiceId: a.invoiceId, amount: usd(a.amount) })) ?? [];

    if (allocations.length === 0) {
      // Oldest balance first.
      const open = await tx.select().from(schema.invoice)
        .where(and(
          eq(schema.invoice.customerId, input.customerId),
          inArray(schema.invoice.status, ["open", "partially_paid"]),
        ))
        .orderBy(schema.invoice.issuedOn);

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

    const [payment] = await tx.insert(schema.payment).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId,
      method: input.method,
      status: "succeeded",
      amount: m.toString(amount),
      tipAmount: m.toString(tip),
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
      checkNumber: input.checkNumber ?? null,
      notes: input.notes ?? null,
      processorPaymentId: input.processorPaymentId ?? null,
      idempotencyKey: ctx.idempotencyKey ?? `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }).returning();

    for (const allocation of allocations) {
      await tx.insert(schema.paymentAllocation).values({
        organizationId: ctx.actor.organizationId,
        paymentId: payment!.id,
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
    }

    const transactionId = await writePosting(tx, ctx, ledger.postPayment({
      paymentId: payment!.id,
      occurredAt: new Date(),
      appliedAmount: allocatedTotal,
      tipAmount: tip,
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

    await audit(tx, ctx, "payment.recorded", "payment", payment!.id, null, payment!);

    return {
      id: payment!.id,
      amount: m.toString(amount),
      allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: m.toString(a.amount) })),
      ledgerTransactionId: transactionId,
    };
  });
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
