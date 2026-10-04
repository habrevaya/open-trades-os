import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { isSystem, ledger, money as m, time } from "@opentradesos/core";
import type { z } from "zod";
import {
  audit, type ServiceContext, guardedRead, guardedWrite, decodeCursor, paginate,
  NotFoundError, ConflictError, UnprocessableError, timezoneOf,
} from "./context";
import { writePosting } from "./ledger";
import { nextNumber } from "./jobs";
import type {
  createCreditNote, listCreditNotes, CreditNoteReason,
} from "../contracts/credit-notes";

const usd = (v: string) => m.money(v, "USD");
const zero = usd("0");
/** Dollars and cents in a sentence a person reads, not the column's four places. */
const say = (v: m.Money | string) => m.edit(m.round(typeof v === "string" ? usd(v) : v, 2));

/**
 * CREDIT NOTES
 *
 * The bill asked for too much, or the company chose to give something back.
 * Neither is a void (the invoice was right to exist) nor a write off (nothing
 * was lost to a customer who would not pay). See `schema/billing.ts` for why
 * this is its own document and not a negative invoice.
 *
 * Two acts, each with its own posting:
 *
 *   ISSUING reverses the revenue and the sales tax for what is credited, and
 *     leaves the amount owed to the customer in customer deposits.
 *   APPLYING settles some of that against an invoice's receivable.
 *
 * Kept apart because a credit is often raised before the invoice it will be
 * used on exists, and an unapplied credit is money the company owes. If the
 * two were one step, a credit with nowhere to go would have nowhere to be.
 */

type Note = typeof schema.creditNote.$inferSelect;
type InvoiceRow = typeof schema.invoice.$inferSelect;
export type Payout = typeof schema.creditNotePayout.$inferSelect;

/**
 * What is left on a credit note and what that makes it, from what it was
 * issued for, what was used on invoices and what was paid out as money.
 *
 * One function for every path that moves any of the three, so "part used"
 * means the same thing whether the part went on an invoice or back to a card.
 * A credit with nothing left reads as applied, the word every list already
 * uses for "used up", whichever way it went.
 */
function standingOf(total: m.Money, applied: m.Money, paidOut: m.Money) {
  const balance = m.subtract(m.subtract(total, applied), paidOut);
  const status: Note["status"] = m.isPositive(balance)
    ? (m.isPositive(m.add(applied, paidOut)) ? "partially_applied" : "open")
    : "applied";
  return { balance, status };
}

/* --------------------------------------------------------------- reading */

async function loadNote(tx: Database, id: string) {
  const [row] = await tx.select({
    note: schema.creditNote,
    customerName: schema.customer.name,
    invoiceNumber: schema.invoice.number,
  })
    .from(schema.creditNote)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.creditNote.customerId))
    .leftJoin(schema.invoice, eq(schema.invoice.id, schema.creditNote.invoiceId))
    .where(eq(schema.creditNote.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("Credit note");
  return view(tx, [row]).then((v) => v[0]!);
}

async function view(
  tx: Database,
  rows: Array<{ note: Note; customerName: string; invoiceNumber: number | null }>,
) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.note.id);
  const lines = await tx.select().from(schema.creditNoteLine)
    .where(inArray(schema.creditNoteLine.creditNoteId, ids))
    .orderBy(schema.creditNoteLine.sortOrder);
  const payouts = await tx.select().from(schema.creditNotePayout)
    .where(inArray(schema.creditNotePayout.creditNoteId, ids))
    .orderBy(schema.creditNotePayout.createdAt);
  const applications = await tx.select({
    application: schema.creditNoteApplication,
    invoiceNumber: schema.invoice.number,
  })
    .from(schema.creditNoteApplication)
    .innerJoin(schema.invoice, eq(schema.invoice.id, schema.creditNoteApplication.invoiceId))
    .where(inArray(schema.creditNoteApplication.creditNoteId, ids))
    .orderBy(schema.creditNoteApplication.createdAt);

  return rows.map(({ note, customerName, invoiceNumber }) => ({
    id: note.id,
    number: note.number,
    status: note.status,
    customerId: note.customerId,
    customerName,
    invoiceId: note.invoiceId,
    invoiceNumber: note.invoiceId ? invoiceNumber : null,
    reason: note.reason,
    note: note.note,
    issuedOn: note.issuedOn,
    currency: note.currency,
    subtotal: note.subtotal,
    taxTotal: note.taxTotal,
    total: note.total,
    amountApplied: note.amountApplied,
    amountPaidOut: note.amountPaidOut,
    balance: note.balance,
    voidedAt: note.voidedAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    lines: lines.filter((l) => l.creditNoteId === note.id).map((l) => ({
      id: l.id,
      invoiceLineId: l.invoiceLineId,
      name: l.name,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
      taxRate: l.taxRate,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
    })),
    applications: applications.filter((a) => a.application.creditNoteId === note.id).map((a) => ({
      id: a.application.id,
      invoiceId: a.application.invoiceId,
      invoiceNumber: a.invoiceNumber,
      amount: a.application.amount,
      appliedOn: a.application.appliedOn,
    })),
    payouts: payouts.filter((p) => p.creditNoteId === note.id).map((p) => ({
      id: p.id,
      method: p.method as PayoutMethod,
      status: p.status as PayoutStatus,
      amount: p.amount,
      paymentId: p.paymentId,
      reference: p.reference,
      paidOn: p.paidOn,
      note: p.note,
      failureReason: p.failureReason,
      createdAt: p.createdAt,
    })),
  }));
}

export type PayoutMethod = "card" | "cash" | "check" | "other";
export type PayoutStatus = "pending" | "paid" | "failed";

export type CreditNoteView = Awaited<ReturnType<typeof loadNote>>;
export { loadNote };

export async function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "invoice:read", (tx) => loadNote(tx, input.id));
}

export async function list(ctx: ServiceContext, input: z.infer<typeof listCreditNotes.input>) {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const cursor = decodeCursor(input.cursor);
    const rows = await tx.select({
      note: schema.creditNote,
      customerName: schema.customer.name,
      invoiceNumber: schema.invoice.number,
    })
      .from(schema.creditNote)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.creditNote.customerId))
      .leftJoin(schema.invoice, eq(schema.invoice.id, schema.creditNote.invoiceId))
      .where(and(
        input.customerId ? eq(schema.creditNote.customerId, input.customerId) : undefined,
        input.invoiceId ? eq(schema.creditNote.invoiceId, input.invoiceId) : undefined,
        input.status ? eq(schema.creditNote.status, input.status) : undefined,
        cursor ? lt(schema.creditNote.createdAt, new Date(cursor)) : undefined,
      ))
      .orderBy(desc(schema.creditNote.createdAt))
      .limit(input.limit + 1);
    const page = paginate(rows, input.limit, (r) => r.note.createdAt.toISOString());
    return { ...page, data: await view(tx, page.data) };
  });
}

/**
 * Credit a customer holds and has not used, across every credit note.
 *
 * What the customer page and the statement show as "credit on account". A
 * customer told they owe four hundred dollars when the company owes them
 * fifty back has been told the wrong number.
 */
export async function unappliedFor(tx: Database, customerId: string): Promise<string> {
  const [row] = await tx.select({
    total: sql<string>`coalesce(sum(${schema.creditNote.balance}), 0)::text`,
  }).from(schema.creditNote).where(and(
    eq(schema.creditNote.customerId, customerId),
    inArray(schema.creditNote.status, ["open", "partially_applied"]),
  ));
  return row?.total ?? "0";
}

/* -------------------------------------------------------------- raising */

type LineInput = z.infer<typeof createCreditNote.input>["lines"][number];

/**
 * Lines priced, and checked against what the invoice actually charged.
 *
 * Tax comes from the invoice line, AS APPLIED, never from today's rate: a
 * credit for work billed at last year's rate gives back last year's tax, or
 * the company refunds tax it never collected.
 *
 * A line can never credit more than its invoice line charged, counting every
 * credit already issued against it. Without that the same capacitor can be
 * credited twice by two people on the same afternoon, and each credit looks
 * reasonable on its own.
 */
async function priceLines(
  tx: Database, invoice: InvoiceRow | null, lines: LineInput[], ownNoteId?: string,
) {
  const invoiceLines = invoice
    ? await tx.select().from(schema.invoiceLine).where(eq(schema.invoiceLine.invoiceId, invoice.id))
    : [];
  const byId = new Map(invoiceLines.map((l) => [l.id, l]));

  const priced = lines.map((line, index) => {
    const quantity = line.quantity ?? "1";
    if (!m.isPositive(usd(quantity)) || !m.isPositive(usd(line.unitPrice))) {
      throw new UnprocessableError("A credit line takes a positive quantity and price", [{
        path: `lines.${index}`, message: "Credit a positive amount. A credit note only ever gives back.",
      }]);
    }
    if (line.invoiceLineId) {
      const source = byId.get(line.invoiceLineId);
      if (!source) {
        throw new UnprocessableError("That line is not on this invoice", [{
          path: `lines.${index}.invoiceLineId`,
          message: invoice ? `Line not found on invoice ${invoice.number}.` : "A line can only be credited against its invoice.",
        }]);
      }
      return {
        invoiceLineId: source.id,
        name: line.name ?? source.name,
        description: line.description ?? source.description,
        quantity,
        unitPrice: line.unitPrice,
        taxable: source.taxable,
        taxRate: source.taxRate,
      };
    }
    if (!line.name) {
      throw new UnprocessableError("A credit line needs a name", [{
        path: `lines.${index}.name`, message: "Say what is being credited.",
      }]);
    }
    return {
      invoiceLineId: null,
      name: line.name,
      description: line.description ?? null,
      quantity,
      unitPrice: line.unitPrice,
      taxable: line.taxable ?? false,
      taxRate: line.taxRate ?? "0",
    };
  });

  const computed = ledger.computeInvoice(priced.map((l) => ({
    quantity: l.quantity, unitPrice: usd(l.unitPrice), taxable: l.taxable, taxRate: l.taxRate,
  })));

  /** Per invoice line, this note against what it charged less earlier credits. */
  const asked = new Map<string, m.Money>();
  priced.forEach((l, i) => {
    if (!l.invoiceLineId) return;
    asked.set(l.invoiceLineId, m.add(asked.get(l.invoiceLineId) ?? zero, computed.lines[i]!.lineTotal));
  });
  if (asked.size > 0) {
    const earlier = await tx.select({
      invoiceLineId: schema.creditNoteLine.invoiceLineId,
      total: sql<string>`coalesce(sum(${schema.creditNoteLine.lineTotal}), 0)::text`,
    })
      .from(schema.creditNoteLine)
      .innerJoin(schema.creditNote, eq(schema.creditNote.id, schema.creditNoteLine.creditNoteId))
      .where(and(
        inArray(schema.creditNoteLine.invoiceLineId, [...asked.keys()]),
        ne(schema.creditNote.status, "void"),
        ownNoteId ? ne(schema.creditNote.id, ownNoteId) : undefined,
      ))
      .groupBy(schema.creditNoteLine.invoiceLineId);
    const before = new Map(earlier.map((e) => [e.invoiceLineId!, usd(e.total)]));
    for (const [lineId, amount] of asked) {
      const source = byId.get(lineId)!;
      const room = m.subtract(usd(source.lineTotal), before.get(lineId) ?? zero);
      if (m.compare(amount, room) > 0) {
        throw new ConflictError(
          `"${source.name}" charged ${say(usd(source.lineTotal))} and has ${say(m.isNegative(room) ? zero : room)} left to credit, less than ${say(amount)}.`,
        );
      }
    }
  }

  return { lines: priced.map((l, i) => ({ ...l, computed: computed.lines[i]! })), totals: computed.totals };
}

/**
 * The invoice a credit is raised against, if one is, and the refusals that
 * belong to it.
 */
async function invoiceFor(tx: Database, invoiceId: string | undefined): Promise<InvoiceRow | null> {
  if (!invoiceId) return null;
  const [invoice] = await tx.select().from(schema.invoice)
    .where(and(eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt))).limit(1);
  if (!invoice) throw new NotFoundError("Invoice");
  if (invoice.status === "draft") {
    throw new ConflictError(`Invoice ${invoice.number} is still a draft. Change the draft rather than crediting it.`);
  }
  if (invoice.status === "void" || invoice.status === "written_off") {
    throw new ConflictError(
      `Invoice ${invoice.number} is ${invoice.status.replace("_", " ")}. There is nothing on it left to credit.`,
    );
  }
  return invoice;
}

/**
 * Never more credit against one invoice than it billed.
 *
 * Counted across every live credit note, including drafts, because two drafts
 * raised from the same complaint are how a customer is credited twice.
 */
async function assertWithinInvoice(
  tx: Database, invoice: InvoiceRow, total: m.Money, ownNoteId?: string,
): Promise<void> {
  const [row] = await tx.select({
    total: sql<string>`coalesce(sum(${schema.creditNote.total}), 0)::text`,
  }).from(schema.creditNote).where(and(
    eq(schema.creditNote.invoiceId, invoice.id),
    ne(schema.creditNote.status, "void"),
    ownNoteId ? ne(schema.creditNote.id, ownNoteId) : undefined,
  ));
  const room = m.subtract(usd(invoice.total), usd(row?.total ?? "0"));
  if (m.compare(total, room) > 0) {
    throw new ConflictError(
      `Invoice ${invoice.number} billed ${say(usd(invoice.total))} and has ${say(m.isNegative(room) ? zero : room)} left that can be credited, less than ${say(total)}.`,
    );
  }
}

function assertReason(reason: z.infer<typeof CreditNoteReason>, note: string | undefined | null): void {
  /**
   * Goodwill is a decision somebody made, and the only one on the list that
   * says nothing about what went wrong. Six months on, "goodwill" with no
   * words beside it is a credit nobody can explain.
   */
  if (reason === "goodwill" && !note?.trim()) {
    throw new UnprocessableError("Goodwill needs a note", [{
      path: "note", message: "Say why the credit was given. Goodwill on its own explains nothing later.",
    }]);
  }
}

export async function create(ctx: ServiceContext, input: z.infer<typeof createCreditNote.input>) {
  return guardedWrite(ctx, "invoice:credit", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "credit_note"),
        )).limit(1);
      if (seen?.entityId) return loadNote(tx, seen.entityId);
    }

    assertReason(input.reason, input.note);
    const invoice = await invoiceFor(tx, input.invoiceId);
    const customerId = invoice?.customerId ?? input.customerId;
    if (!customerId) {
      throw new UnprocessableError("A credit note is for somebody", [{
        path: "customerId", message: "Name the customer, or the invoice being credited.",
      }]);
    }
    if (invoice && input.customerId && input.customerId !== invoice.customerId) {
      throw new ConflictError(`Invoice ${invoice.number} is not this customer's.`);
    }
    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt))).limit(1);
    if (!customer) throw new NotFoundError("Customer");

    const priced = await priceLines(tx, invoice, input.lines);
    if (invoice) await assertWithinInvoice(tx, invoice, priced.totals.total);

    const number = await nextNumber(tx, ctx.actor.organizationId, "credit_note");
    const [note] = await tx.insert(schema.creditNote).values({
      organizationId: ctx.actor.organizationId,
      number,
      customerId,
      invoiceId: invoice?.id ?? null,
      status: "draft",
      reason: input.reason,
      note: input.note?.trim() || null,
      subtotal: m.toString(priced.totals.subtotal),
      taxTotal: m.toString(priced.totals.taxTotal),
      total: m.toString(priced.totals.total),
    }).returning();

    await tx.insert(schema.creditNoteLine).values(priced.lines.map((l, i) => ({
      organizationId: ctx.actor.organizationId,
      creditNoteId: note!.id,
      invoiceLineId: l.invoiceLineId,
      sortOrder: i,
      name: l.name,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
      taxRate: l.taxRate,
      taxAmount: m.toString(l.computed.taxAmount),
      lineTotal: m.toString(l.computed.lineTotal),
    })));

    await audit(tx, ctx, "credit_note.created", "credit_note", note!.id, null,
      { number, reason: input.reason, total: note!.total, invoiceId: note!.invoiceId });

    if (!input.draft) await issueInTx(tx, ctx, note!, input.apply);

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "credit_note.create",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "credit_note", entityId: note!.id,
      });
    }
    return loadNote(tx, note!.id);
  });
}

/* -------------------------------------------------------------- issuing */

async function issueInTx(tx: Database, ctx: ServiceContext, note: Note, apply: boolean): Promise<void> {
  /** Checked again: the invoice may have been credited or closed since the draft. */
  const invoice = note.invoiceId ? await invoiceFor(tx, note.invoiceId) : null;
  if (invoice) await assertWithinInvoice(tx, invoice, usd(note.total), note.id);

  const now = new Date();
  const issuedOn = time.dateIn(now, await timezoneOf(tx, ctx.actor.organizationId));
  await writePosting(tx, ctx, ledger.postCreditNote({
    creditNoteId: note.id,
    occurredAt: now,
    totals: { subtotal: usd(note.subtotal), taxTotal: usd(note.taxTotal), total: usd(note.total) },
    customerId: note.customerId,
    ...(note.invoiceId ? { invoiceId: note.invoiceId } : {}),
    ...(invoice?.jobId ? { jobId: invoice.jobId } : {}),
  }));

  const [issued] = await tx.update(schema.creditNote).set({
    status: "open",
    issuedOn,
    balance: note.total,
    issuedByUserId: ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId,
    updatedAt: now,
  }).where(eq(schema.creditNote.id, note.id)).returning();

  await audit(tx, ctx, "credit_note.issued", "credit_note", note.id,
    { status: note.status }, { status: "open", total: note.total, issuedOn });

  /**
   * ON ITS OWN INVOICE BY DEFAULT, up to what that invoice still owes. That is
   * what "credit this invoice" means to the person doing it. What the invoice
   * no longer owes (it was paid already) stays on the account as credit.
   */
  if (apply && invoice && m.isPositive(usd(invoice.balance))
    && (invoice.status === "open" || invoice.status === "partially_paid")) {
    const amount = m.compare(usd(invoice.balance), usd(issued!.balance)) < 0
      ? usd(invoice.balance) : usd(issued!.balance);
    await applyInTx(tx, ctx, issued!, [{ invoiceId: invoice.id, amount }]);
  }
}

export async function issue(ctx: ServiceContext, input: { id: string; apply: boolean }) {
  return guardedWrite(ctx, "invoice:credit", async (tx) => {
    const note = await lockNote(tx, input.id);
    /** A retry of an issue that went through is answered, not refused. */
    if (note.status !== "draft") return loadNote(tx, note.id);
    await issueInTx(tx, ctx, note, input.apply);
    return loadNote(tx, note.id);
  });
}

export async function lockNote(tx: Database, id: string): Promise<Note> {
  const [note] = await tx.select().from(schema.creditNote)
    .where(eq(schema.creditNote.id, id))
    .for("update").limit(1);
  if (!note) throw new NotFoundError("Credit note");
  return note;
}

/* ------------------------------------------------------------- applying */

async function applyInTx(
  tx: Database, ctx: ServiceContext, note: Note,
  applications: Array<{ invoiceId: string; amount: m.Money }>,
): Promise<void> {
  if (note.status !== "open" && note.status !== "partially_applied") {
    throw new ConflictError(
      note.status === "draft"
        ? `Credit note ${note.number} is a draft. Issue it before applying it.`
        : `Credit note ${note.number} is ${note.status.replace("_", " ")} and has nothing left to apply.`,
    );
  }
  if (applications.some((a) => !m.isPositive(a.amount))) {
    throw new UnprocessableError("Each application must be a positive amount", [{
      path: "applications", message: "Apply a positive amount to each invoice.",
    }]);
  }
  const total = m.sum(applications.map((a) => a.amount), "USD");
  if (m.compare(total, usd(note.balance)) > 0) {
    throw new ConflictError(
      `Credit note ${note.number} has ${say(usd(note.balance))} left to apply, and ${say(total)} was asked for.`,
    );
  }

  const byInvoice = new Map<string, m.Money>();
  for (const a of applications) byInvoice.set(a.invoiceId, m.add(byInvoice.get(a.invoiceId) ?? zero, a.amount));

  const now = new Date();
  const appliedOn = time.dateIn(now, await timezoneOf(tx, ctx.actor.organizationId));

  for (const [invoiceId, amount] of byInvoice) {
    const [invoice] = await tx.select().from(schema.invoice)
      .where(and(eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt)))
      .for("update").limit(1);
    if (!invoice) throw new NotFoundError("Invoice");
    /**
     * This customer's, or one they are the payer on. Moving one customer's
     * credit onto another's invoice is a transfer between customers, and that
     * is a conversation with both of them rather than a click.
     */
    if (invoice.customerId !== note.customerId && invoice.payerCustomerId !== note.customerId) {
      throw new ConflictError(`Invoice ${invoice.number} is not this customer's.`);
    }
    if (invoice.status !== "open" && invoice.status !== "partially_paid") {
      throw new ConflictError(`Invoice ${invoice.number} is ${invoice.status.replace("_", " ")} and takes no credit.`);
    }
    if (m.compare(amount, usd(invoice.balance)) > 0) {
      throw new ConflictError(
        `Invoice ${invoice.number} owes ${say(usd(invoice.balance))}, less than ${say(amount)}.`,
      );
    }

    await tx.insert(schema.creditNoteApplication).values({
      organizationId: ctx.actor.organizationId,
      creditNoteId: note.id, invoiceId, amount: m.toString(amount), appliedOn,
    });
    const balance = m.subtract(usd(invoice.balance), amount);
    /**
     * Settled reads as paid, which is the word every list in this product
     * already uses for "owes nothing". The paid AMOUNT is left alone, so a
     * collections report never counts a credit as cash.
     */
    await tx.update(schema.invoice).set({
      amountCredited: m.toString(m.add(usd(invoice.amountCredited), amount)),
      balance: m.toString(balance),
      status: m.isPositive(balance) ? "partially_paid" : "paid",
      updatedAt: now,
    }).where(eq(schema.invoice.id, invoiceId));
    if (invoice.jobId && !m.isPositive(balance)) {
      await tx.update(schema.job).set({ status: "paid", updatedAt: now })
        .where(and(eq(schema.job.id, invoice.jobId), eq(schema.job.status, "invoiced")));
    }
  }

  await writePosting(tx, ctx, ledger.postCreditNoteApplication({
    creditNoteId: note.id, occurredAt: now, amount: total, customerId: note.customerId,
  }));

  const applied = m.add(usd(note.amountApplied), total);
  const { balance: left, status } = standingOf(usd(note.total), applied, usd(note.amountPaidOut));
  await tx.update(schema.creditNote).set({
    amountApplied: m.toString(applied),
    balance: m.toString(left),
    status,
    updatedAt: now,
  }).where(eq(schema.creditNote.id, note.id));

  await audit(tx, ctx, "credit_note.applied", "credit_note", note.id,
    { balance: note.balance },
    {
      balance: m.toString(left),
      applications: [...byInvoice].map(([invoiceId, amount]) => ({ invoiceId, amount: m.toString(amount) })),
    });
}

export async function apply(
  ctx: ServiceContext,
  input: { id: string; applications: Array<{ invoiceId: string; amount: string }> },
) {
  return guardedWrite(ctx, "invoice:credit", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.entityType, "credit_note_application"),
        )).limit(1);
      if (seen?.entityId) return loadNote(tx, seen.entityId);
    }
    const note = await lockNote(tx, input.id);
    await applyInTx(tx, ctx, note, input.applications.map((a) => ({ invoiceId: a.invoiceId, amount: usd(a.amount) })));
    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "inbound", provider: "api", eventType: "credit_note.apply",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "credit_note_application", entityId: note.id,
      });
    }
    return loadNote(tx, note.id);
  });
}

/* ------------------------------------------------------ paying it out */

/**
 * Set aside part of a credit note for a payout, so the same credit cannot
 * also be used on an invoice or paid out twice while a card refund is on its
 * way. Nothing is posted: the money has not moved yet.
 */
export async function reservePayout(tx: Database, note: Note, amount: m.Money): Promise<void> {
  if (note.status !== "open" && note.status !== "partially_applied") {
    throw new ConflictError(
      note.status === "draft"
        ? `Credit note ${note.number} is a draft. Issue it before paying it out.`
        : `Credit note ${note.number} is ${note.status.replace("_", " ")} and has nothing left to pay out.`,
    );
  }
  if (!m.isPositive(amount)) {
    throw new UnprocessableError("A payout is a positive amount", [{
      path: "amount", message: "Pay out a positive amount.",
    }]);
  }
  if (m.compare(amount, usd(note.balance)) > 0) {
    throw new ConflictError(
      `Credit note ${note.number} has ${say(usd(note.balance))} left, and ${say(amount)} was asked to be paid out.`,
    );
  }
  const paidOut = m.add(usd(note.amountPaidOut), amount);
  const { balance, status } = standingOf(usd(note.total), usd(note.amountApplied), paidOut);
  await tx.update(schema.creditNote).set({
    amountPaidOut: m.toString(paidOut), balance: m.toString(balance), status, updatedAt: new Date(),
  }).where(eq(schema.creditNote.id, note.id));
}

/**
 * The money has gone: post it and say so on the payout.
 *
 * Dated `at`, which is when it went: the processor's own time for a card
 * refund, the day the office says for cash or a cheque.
 */
export async function postPayout(tx: Database, ctx: ServiceContext, payout: Payout, at: Date): Promise<Payout> {
  await writePosting(tx, ctx, ledger.postCreditNotePayout({
    payoutId: payout.id, occurredAt: at, amount: usd(payout.amount), customerId: payout.customerId,
  }));
  const paidOn = time.dateIn(at, await timezoneOf(tx, ctx.actor.organizationId));
  const [after] = await tx.update(schema.creditNotePayout).set({
    status: "paid", paidAt: at, paidOn, updatedAt: new Date(),
  }).where(eq(schema.creditNotePayout.id, payout.id)).returning();
  await audit(tx, ctx, "credit_note.paid_out", "credit_note", payout.creditNoteId,
    { status: payout.status }, { payoutId: payout.id, method: payout.method, amount: payout.amount, paidOn });
  return after!;
}

/**
 * The processor reported a card payout's refund done.
 *
 * Posted as a payout, and the card payment it went back through records the
 * money as refunded, which is what the processor will say about it, and as
 * paid out, so what the payment paid and holds is left as it was
 * (`billing.unappliedOf`). Called by the webhook path in `payments.ts`
 * with the payment row already locked. Safe to call twice: a payout that is
 * no longer pending is left alone.
 */
export async function settleCardPayout(
  tx: Database, ctx: ServiceContext, payout: Payout, payment: typeof schema.payment.$inferSelect, at: Date,
): Promise<typeof schema.payment.$inferSelect> {
  if (payout.status !== "pending") return payment;
  await postPayout(tx, ctx, payout, at);
  const refunded = m.add(usd(payment.refundedAmount), usd(payout.amount));
  const [after] = await tx.update(schema.payment).set({
    refundedAmount: m.toString(refunded),
    paidOutAmount: m.toString(m.add(usd(payment.paidOutAmount), usd(payout.amount))),
    status: m.compare(refunded, usd(payment.amount)) >= 0 ? "refunded" : "partially_refunded",
    updatedAt: new Date(),
  }).where(eq(schema.payment.id, payment.id)).returning();
  return after!;
}

/**
 * A card payout the processor will not make. The credit it set aside goes
 * back on the account, because nothing left: the customer still holds it,
 * to be used or paid out another way. Nothing was posted, so nothing is
 * reversed.
 */
export async function failCardPayout(
  tx: Database, ctx: ServiceContext, payout: Payout, reason: string,
): Promise<void> {
  if (payout.status !== "pending") return;
  await tx.update(schema.creditNotePayout).set({
    status: "failed", failureReason: reason, updatedAt: new Date(),
  }).where(eq(schema.creditNotePayout.id, payout.id));
  const note = await lockNote(tx, payout.creditNoteId);
  const paidOut = m.subtract(usd(note.amountPaidOut), usd(payout.amount));
  const { balance, status } = standingOf(usd(note.total), usd(note.amountApplied), paidOut);
  await tx.update(schema.creditNote).set({
    amountPaidOut: m.toString(paidOut), balance: m.toString(balance), status, updatedAt: new Date(),
  }).where(eq(schema.creditNote.id, note.id));
  await audit(tx, ctx, "credit_note.payout_failed", "credit_note", note.id,
    { payoutId: payout.id, status: "pending" }, { status: "failed", reason, balance: m.toString(balance) });
}

/** Card payouts on one payment still waiting for the processor, oldest first. */
export async function pendingPayoutsOn(tx: Database, paymentId: string): Promise<Payout[]> {
  return tx.select().from(schema.creditNotePayout)
    .where(and(
      eq(schema.creditNotePayout.paymentId, paymentId),
      eq(schema.creditNotePayout.status, "pending"),
    ))
    .orderBy(schema.creditNotePayout.createdAt);
}

/** The payout a processor refund id belongs to, if one does. */
export async function payoutForRefund(
  tx: Database, organizationId: string, refundId: string,
): Promise<Payout | null> {
  const [row] = await tx.select().from(schema.creditNotePayout)
    .where(and(
      eq(schema.creditNotePayout.organizationId, organizationId),
      eq(schema.creditNotePayout.processorRefundId, refundId),
    )).limit(1);
  return row ?? null;
}

/* ------------------------------------------------------ voiding, deleting */

export async function voidNote(ctx: ServiceContext, input: { id: string; reason: string }) {
  return guardedWrite(ctx, "invoice:credit", async (tx) => {
    const note = await lockNote(tx, input.id);
    if (note.status === "void") return loadNote(tx, note.id);
    if (note.status === "draft") {
      throw new ConflictError(`Credit note ${note.number} is still a draft. Delete it rather than voiding it.`);
    }
    if (m.isPositive(usd(note.amountApplied))) {
      throw new ConflictError(
        `Credit note ${note.number} has ${say(usd(note.amountApplied))} applied to invoices. A credit that has been used cannot be taken back here.`,
      );
    }
    if (m.isPositive(usd(note.amountPaidOut))) {
      throw new ConflictError(
        `Credit note ${note.number} has ${say(usd(note.amountPaidOut))} paid out to the customer. Money that has gone back cannot be taken back here.`,
      );
    }
    /** The job the credited invoice was for, so restoring the revenue restores it on that job. */
    const [credited] = note.invoiceId
      ? await tx.select({ jobId: schema.invoice.jobId }).from(schema.invoice).where(eq(schema.invoice.id, note.invoiceId)).limit(1)
      : [];
    await writePosting(tx, ctx, ledger.postCreditNoteVoid({
      creditNoteId: note.id,
      occurredAt: new Date(),
      totals: { subtotal: usd(note.subtotal), taxTotal: usd(note.taxTotal), total: usd(note.total) },
      customerId: note.customerId,
      ...(credited?.jobId ? { jobId: credited.jobId } : {}),
    }));
    await tx.update(schema.creditNote).set({
      status: "void", balance: "0", voidedAt: new Date(), updatedAt: new Date(),
    }).where(eq(schema.creditNote.id, note.id));
    await audit(tx, ctx, "credit_note.voided", "credit_note", note.id,
      { status: note.status, balance: note.balance }, { status: "void", reason: input.reason });
    return loadNote(tx, note.id);
  });
}

export async function deleteDraft(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "invoice:credit", async (tx) => {
    const [note] = await tx.select().from(schema.creditNote)
      .where(eq(schema.creditNote.id, input.id)).limit(1);
    /** A retry finds nothing and says so: the draft it asked about is gone. */
    if (!note) return { deleted: true as const, id: input.id };
    if (note.status !== "draft") {
      throw new ConflictError(`Credit note ${note.number} is issued. Void it rather than deleting it.`);
    }
    await tx.delete(schema.creditNote).where(eq(schema.creditNote.id, note.id));
    await audit(tx, ctx, "credit_note.draft_deleted", "credit_note", note.id, note, null);
    return { deleted: true as const, id: note.id };
  });
}

export const handlers = {
  createCreditNote: create,
  issueCreditNote: issue,
  applyCreditNote: apply,
  voidCreditNote: voidNote,
  deleteCreditNote: deleteDraft,
  getCreditNote: get,
  listCreditNotes: list,
};
