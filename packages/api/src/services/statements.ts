import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m, time } from "@opentradesos/core";
import type { z } from "zod";
import {
  type ServiceContext, contactOf, guardedRead, NotFoundError, UnprocessableError, timezoneOf,
} from "./context";
import type { getCustomerStatement, StatementLineKind } from "../contracts/statements";

const usd = (v: string) => m.money(v, "USD");
const zero = usd("0");
const text = (v: m.Money) => m.toString(m.round(v, 2));

/** Postings whose source is an invoice, and so belong to whoever pays it. */
const INVOICE_SOURCES = ["invoice", "void", "write_off", "agreement_billing"] as const;

const KIND: Record<string, z.infer<typeof StatementLineKind>> = {
  invoice: "invoice", agreement_billing: "agreement", payment: "payment", refund: "refund",
  void: "void", write_off: "write_off", credit_note: "credit_note", credit_note_void: "credit_note_void",
  credit_note_payout: "credit_payout",
  deposit: "deposit", deposit_refund: "deposit_refund", deposit_forfeiture: "deposit_kept",
};

const METHOD: Record<string, string> = {
  card: "card", card_present: "card", ach: "bank transfer", cash: "cash", check: "cheque",
  financing: "financing", credit: "credit", other: "other",
};

/**
 * The statement.
 *
 * Each ledger transaction that touches the customer's receivable (1200) or the
 * money held for them (2300) becomes one line, its amount the net effect on
 * what they owe: a debit to either account adds to it, a credit takes from it.
 * A transaction that only moves money between the two (a held payment applied,
 * a credit used, a deposit put against an invoice) nets to nothing and is not
 * a line, because nothing the customer owes changed.
 */
export async function statement(ctx: ServiceContext, input: z.infer<typeof getCustomerStatement.input>) {
  return guardedRead(ctx, "invoice:read", (tx) =>
    buildStatement(tx, ctx.actor.organizationId, input.id, input));
}

/**
 * The statement inside a transaction that is already scoped to the company:
 * the office's session above, or the customer's own link in the portal.
 */
export async function buildStatement(
  tx: Database, organizationId: string, customerId: string,
  input: { from?: string | undefined; to?: string | undefined },
) {
  {
    const [customer] = await tx.select({ id: schema.customer.id, name: schema.customer.name })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt))).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, organizationId)).limit(1);

    const zone = await timezoneOf(tx, organizationId);
    const today = time.dateIn(new Date(), zone);
    const to = input.to ?? today;
    const from = input.from ?? shift(to, -89);
    if (from > to) {
      throw new UnprocessableError("The period ends before it starts", [{ path: "from", message: "Start on or before the end." }]);
    }
    if (to > today) {
      throw new UnprocessableError("A statement cannot run past today", [{ path: "to", message: `End on ${today} or earlier.` }]);
    }
    const start = time.startOfDayIn(from, zone);
    const end = time.startOfDayIn(time.nextDay(to), zone);

    const rows = await entriesFor(tx, customer.id, end);

    /** One line per transaction, in the order it happened. */
    const byTransaction = new Map<string, { at: Date; created: Date; sourceType: string; sourceId: string; net: m.Money }>();
    for (const row of rows) {
      const signed = row.direction === "debit" ? usd(row.amount) : m.negate(usd(row.amount));
      const seen = byTransaction.get(row.transactionId);
      if (seen) seen.net = m.add(seen.net, signed);
      else byTransaction.set(row.transactionId, {
        at: row.occurredAt, created: row.createdAt, sourceType: row.sourceType, sourceId: row.sourceId, net: signed,
      });
    }
    const transactions = [...byTransaction.values()]
      .filter((x) => !m.isZero(x.net))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.created.getTime() - b.created.getTime());

    const opening = m.sum(transactions.filter((x) => x.at < start).map((x) => x.net), "USD");
    const inPeriod = transactions.filter((x) => x.at >= start);
    const names = await describe(tx, inPeriod);

    let running = opening;
    const lines = inPeriod.map((x) => {
      running = m.add(running, x.net);
      const isCharge = m.isPositive(x.net);
      return {
        date: time.dateIn(x.at, zone),
        kind: KIND[x.sourceType] ?? "payment",
        description: names.get(`${x.sourceType}:${x.sourceId}`) ?? "Adjustment",
        invoiceId: (INVOICE_SOURCES as readonly string[]).includes(x.sourceType) ? x.sourceId : null,
        amount: text(x.net),
        charge: isCharge ? text(x.net) : null,
        credit: isCharge ? null : text(m.negate(x.net)),
        balance: text(running),
      };
    });

    /** Today's split of what is owed: on invoices, and held for them. */
    const all = await entriesFor(tx, customer.id, null);
    let owed = zero, held = zero;
    for (const row of all) {
      const signed = row.direction === "debit" ? usd(row.amount) : m.negate(usd(row.amount));
      if (row.accountCode === ledger.ACCOUNTS.AR) owed = m.add(owed, signed);
      else held = m.subtract(held, signed);
    }

    const open = await tx.select({
      id: schema.invoice.id, number: schema.invoice.number, issuedOn: schema.invoice.issuedOn,
      dueOn: schema.invoice.dueOn, total: schema.invoice.total, balance: schema.invoice.balance,
    }).from(schema.invoice).where(and(
      sql`coalesce(${schema.invoice.payerCustomerId}, ${schema.invoice.customerId}) = ${customer.id}`,
      inArray(schema.invoice.status, ["open", "partially_paid"]),
      isNull(schema.invoice.deletedAt),
      sql`${schema.invoice.balance} > 0`,
    )).orderBy(schema.invoice.dueOn, schema.invoice.number);

    const buckets = { current: zero, days1To30: zero, days31To60: zero, days61To90: zero, over90: zero };
    const openInvoices = open.map((invoice) => {
      const late = invoice.dueOn && invoice.dueOn < today ? days(invoice.dueOn, today) : 0;
      const key = late === 0 ? "current" : late <= 30 ? "days1To30" : late <= 60 ? "days31To60" : late <= 90 ? "days61To90" : "over90";
      buckets[key] = m.add(buckets[key], usd(invoice.balance));
      return { ...invoice, total: text(usd(invoice.total)), balance: text(usd(invoice.balance)), daysOverdue: late };
    });

    return {
      customerId: customer.id,
      customerName: customer.name,
      organizationName: org?.name ?? "",
      organizationContact: await contactOf(tx, organizationId),
      from, to,
      openingBalance: text(opening),
      closingBalance: text(running),
      owedOnInvoices: text(owed),
      heldOnAccount: text(held),
      lines,
      aging: {
        current: text(buckets.current), days1To30: text(buckets.days1To30), days31To60: text(buckets.days31To60),
        days61To90: text(buckets.days61To90), over90: text(buckets.over90),
      },
      openInvoices,
    };
  }
}

export type Statement = Awaited<ReturnType<typeof buildStatement>>;

/**
 * The customer's postings, before `before` when one is given.
 *
 * Their own, except that a posting sourced from an invoice follows the
 * invoice's payer: a tenant's statement does not show the invoice their
 * property manager pays, and the manager's does.
 */
async function entriesFor(tx: Database, customerId: string, before: Date | null) {
  /** The invoices whose postings move to or from this customer's statement because of who pays. */
  const payerInvoices = sql`select id from public.invoice where payer_customer_id = ${customerId}`;
  const otherPayer = sql`select id from public.invoice
    where customer_id = ${customerId} and payer_customer_id is not null and payer_customer_id <> ${customerId}`;
  const invoiceSourced = inArray(schema.ledgerEntry.sourceType, [...INVOICE_SOURCES]);
  return tx.select({
    transactionId: schema.ledgerEntry.transactionId,
    occurredAt: schema.ledgerEntry.occurredAt,
    createdAt: schema.ledgerEntry.createdAt,
    direction: schema.ledgerEntry.direction,
    accountCode: schema.ledgerEntry.accountCode,
    amount: schema.ledgerEntry.amount,
    sourceType: schema.ledgerEntry.sourceType,
    sourceId: schema.ledgerEntry.sourceId,
  }).from(schema.ledgerEntry).where(and(
    inArray(schema.ledgerEntry.accountCode, [ledger.ACCOUNTS.AR, ledger.ACCOUNTS.CUSTOMER_DEPOSITS]),
    before ? lt(schema.ledgerEntry.occurredAt, before) : undefined,
    or(
      and(eq(schema.ledgerEntry.customerId, customerId),
        sql`not (${invoiceSourced} and ${schema.ledgerEntry.sourceId} in (${otherPayer}))`),
      and(invoiceSourced, sql`${schema.ledgerEntry.sourceId} in (${payerInvoices})`),
    ),
  ));
}

/** "Invoice 1048", "Payment, cheque 2209", "Credit note 3", in one read per kind. */
async function describe(tx: Database, items: Array<{ sourceType: string; sourceId: string }>) {
  const names = new Map<string, string>();
  const ids = (types: string[]) => [...new Set(items.filter((i) => types.includes(i.sourceType)).map((i) => i.sourceId))];

  const invoiceIds = ids([...INVOICE_SOURCES]);
  if (invoiceIds.length > 0) {
    const invoices = await tx.select({ id: schema.invoice.id, number: schema.invoice.number })
      .from(schema.invoice).where(inArray(schema.invoice.id, invoiceIds));
    for (const invoice of invoices) {
      names.set(`invoice:${invoice.id}`, `Invoice ${invoice.number}`);
      names.set(`agreement_billing:${invoice.id}`, `Agreement invoice ${invoice.number}`);
      names.set(`void:${invoice.id}`, `Invoice ${invoice.number} voided`);
      names.set(`write_off:${invoice.id}`, `Invoice ${invoice.number} written off`);
    }
  }
  const paymentIds = ids(["payment", "refund"]);
  if (paymentIds.length > 0) {
    const payments = await tx.select({ id: schema.payment.id, method: schema.payment.method, checkNumber: schema.payment.checkNumber })
      .from(schema.payment).where(inArray(schema.payment.id, paymentIds));
    for (const p of payments) {
      const how = p.method === "check" && p.checkNumber ? `cheque ${p.checkNumber}` : METHOD[p.method] ?? p.method;
      names.set(`payment:${p.id}`, `Payment, ${how}`);
      names.set(`refund:${p.id}`, `Refund, ${how}`);
    }
  }
  const noteIds = ids(["credit_note", "credit_note_void"]);
  if (noteIds.length > 0) {
    const notes = await tx.select({ id: schema.creditNote.id, number: schema.creditNote.number })
      .from(schema.creditNote).where(inArray(schema.creditNote.id, noteIds));
    for (const note of notes) {
      names.set(`credit_note:${note.id}`, `Credit note ${note.number}`);
      names.set(`credit_note_void:${note.id}`, `Credit note ${note.number} voided`);
    }
  }
  const payoutIds = ids(["credit_note_payout"]);
  if (payoutIds.length > 0) {
    const payouts = await tx.select({
      id: schema.creditNotePayout.id, method: schema.creditNotePayout.method,
      reference: schema.creditNotePayout.reference, number: schema.creditNote.number,
    }).from(schema.creditNotePayout)
      .innerJoin(schema.creditNote, eq(schema.creditNote.id, schema.creditNotePayout.creditNoteId))
      .where(inArray(schema.creditNotePayout.id, payoutIds));
    for (const p of payouts) {
      const how = p.method === "card" ? "to your card"
        : p.method === "check" ? (p.reference ? `by cheque ${p.reference}` : "by cheque")
        : p.method === "cash" ? "in cash" : "";
      names.set(`credit_note_payout:${p.id}`, `Credit note ${p.number} paid back ${how}`.trim());
    }
  }
  for (const id of ids(["deposit"])) names.set(`deposit:${id}`, "Deposit received");
  for (const id of ids(["deposit_refund"])) names.set(`deposit_refund:${id}`, "Deposit returned");
  for (const id of ids(["deposit_forfeiture"])) names.set(`deposit_forfeiture:${id}`, "Deposit kept");
  return names;
}

const shift = (date: string, by: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

export const handlers = {
  getCustomerStatement: statement,
};
