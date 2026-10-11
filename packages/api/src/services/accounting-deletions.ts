import { and, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { connectors, work } from "@opentradesos/core";
import type { AccountingEntityKind } from "../accounting/provider";
import { guardedRead, type ServiceContext } from "./context";

/**
 * M14. A DOCUMENT SENT TO THE BOOKS AND DELETED THERE
 *
 * The sync has always stopped believing in a document the accounting system
 * reports deleted: the link is kept, marked `deleted`, and never offered
 * again, so the sync does not argue with the bookkeeper whose books those
 * are. What it did not do was tell anybody. The link's state was on the
 * problems list, which is an API call, and the record here (a journal, a
 * refund, a credit note used on an invoice) looked exactly as if it were
 * still in the books.
 *
 * So noticing a deletion now does two things, on the pass that reads it, and
 * nothing else:
 *
 *   FLAGS THE RECORD HERE. `deletedInBooks` below is what the journal list,
 *   the credit note page and the customer's payments read, and they say on
 *   the record that the books no longer hold it, and since when.
 *
 *   RAISES A TASK FOR THE BOOKKEEPER, in the `books` queue, saying what was
 *   deleted and what the two ways out are.
 *
 * NOTHING IS RE-SENT OR REVERSED BY ITSELF. Whether the books over there or
 * the record here is right is a person's call: a journal deleted in
 * QuickBooks may have been a duplicate somebody also keyed by hand, or a
 * mistake they want back. Sending it again is the retry on the problems list
 * (`POST /v1/accounting/problems/{id}/retry`, or the button beside the flag),
 * and taking it out here is the record's own reversal. Either is a deliberate
 * act by somebody who knows which.
 */

export interface DeletedInBooks {
  /** The link, which is what the retry takes. */
  linkId: string;
  /** The accounting system, in its own words: "QuickBooks Online", "Xero". */
  books: string;
  /** When the sync read that it had gone. */
  noticedAt: string;
  taskId: string | null;
}

/** The accounting system's name as people know it, from the connector catalogue. */
export const booksName = (provider: string): string => connectors.connector(provider)?.label ?? provider;

/**
 * Which of these records were deleted in the connected books after they were
 * sent, by our id. Read inside the caller's own guarded transaction, so it is
 * scoped to the company like everything else the caller reads.
 */
export async function deletedInBooks(
  tx: Database, kinds: AccountingEntityKind[], entityIds: string[],
): Promise<Map<string, DeletedInBooks>> {
  const out = new Map<string, DeletedInBooks>();
  if (entityIds.length === 0) return out;
  const rows = await tx.select({
    entityId: schema.accountingEntityLink.entityId,
    linkId: schema.accountingEntityLink.id,
    noticedAt: schema.accountingEntityLink.deletedNoticedAt,
    updatedAt: schema.accountingEntityLink.updatedAt,
    taskId: schema.accountingEntityLink.deletionTaskId,
    provider: schema.integrationConnection.provider,
  })
    .from(schema.accountingEntityLink)
    .innerJoin(schema.integrationConnection, eq(schema.integrationConnection.id, schema.accountingEntityLink.connectionId))
    .where(and(
      inArray(schema.accountingEntityLink.kind, kinds),
      inArray(schema.accountingEntityLink.entityId, entityIds),
      eq(schema.accountingEntityLink.state, "deleted"),
      /** A connection the company has since left says nothing about its books now. */
      eq(schema.integrationConnection.status, "connected"),
    ));
  for (const row of rows) {
    out.set(row.entityId, {
      linkId: row.linkId,
      books: booksName(row.provider),
      /** A link marked deleted before this was noticed carries no date of its own; its last change is when. */
      noticedAt: (row.noticedAt ?? row.updatedAt).toISOString(),
      taskId: row.taskId,
    });
  }
  return out;
}

/**
 * Refunds of these payments deleted in the books, by payment. A refund's link
 * is keyed by its ledger transaction, because a refund has no row of its own,
 * so it is found through the refund posting against the payment.
 */
export async function refundsDeletedInBooks(
  tx: Database, paymentIds: string[],
): Promise<Map<string, DeletedInBooks[]>> {
  const out = new Map<string, DeletedInBooks[]>();
  if (paymentIds.length === 0) return out;
  const postings = await tx.selectDistinct({
    paymentId: schema.ledgerEntry.sourceId,
    transactionId: schema.ledgerEntry.transactionId,
  }).from(schema.ledgerEntry).where(and(
    eq(schema.ledgerEntry.sourceType, "refund"),
    inArray(schema.ledgerEntry.sourceId, paymentIds),
  ));
  const flags = await deletedInBooks(tx, ["refund"], postings.map((p) => p.transactionId));
  for (const posting of postings) {
    const flag = flags.get(posting.transactionId);
    if (!flag) continue;
    out.set(posting.paymentId, [...(out.get(posting.paymentId) ?? []), flag]);
  }
  return out;
}

/**
 * For the customer's payments on their page: which payments had a refund sent
 * to the books and deleted there. Read by whoever may read payments, because
 * the flag is about a payment they can already see.
 */
export async function paymentRefundFlags(
  ctx: ServiceContext, input: { paymentIds: string[] },
): Promise<Record<string, DeletedInBooks[]>> {
  return guardedRead(ctx, "payment:read", async (tx) =>
    Object.fromEntries(await refundsDeletedInBooks(tx, input.paymentIds)));
}

/** What a task about a deleted document says, and which record it opens. */
interface Described {
  what: string;
  entityType: string | null;
  entityId: string | null;
  /** What putting it right here would be, said for this kind of record. */
  instead: string;
  /** Whether the record's own page shows the flag with a button to send it again. */
  flagged?: boolean;
}

/**
 * The record behind a link, in words a bookkeeper recognises: "Journal 12",
 * "The refund of $40.00 on Rivera Property Group's 2 October payment".
 */
async function describe(tx: Database, kind: AccountingEntityKind, entityId: string): Promise<Described> {
  switch (kind) {
    case "journal": {
      const [row] = await tx.select({ number: schema.journalEntry.number, memo: schema.journalEntry.memo })
        .from(schema.journalEntry).where(eq(schema.journalEntry.id, entityId)).limit(1);
      return {
        what: row ? `Journal ${row.number} (${row.memo})` : "A journal entry",
        entityType: "journal_entry", entityId, flagged: true,
        instead: "or reverse it here on the journal entries page if it should not have been posted",
      };
    }
    case "refund": {
      const [row] = await tx.select({ paymentId: schema.ledgerEntry.sourceId, customerId: schema.payment.customerId })
        .from(schema.ledgerEntry)
        .innerJoin(schema.payment, eq(schema.payment.id, schema.ledgerEntry.sourceId))
        .where(and(eq(schema.ledgerEntry.transactionId, entityId), eq(schema.ledgerEntry.sourceType, "refund")))
        .limit(1);
      return {
        what: "A refund of a payment",
        entityType: row ? "customer" : null, entityId: row?.customerId ?? null, flagged: true,
        instead: "or, if the money never went back, correct it here with the customer's payments",
      };
    }
    case "credit_note_application": {
      const [row] = await tx.select({
        noteId: schema.creditNote.id, note: schema.creditNote.number, invoice: schema.invoice.number,
        prefix: schema.invoice.numberPrefix,
      })
        .from(schema.creditNoteApplication)
        .innerJoin(schema.creditNote, eq(schema.creditNote.id, schema.creditNoteApplication.creditNoteId))
        .innerJoin(schema.invoice, eq(schema.invoice.id, schema.creditNoteApplication.invoiceId))
        .where(eq(schema.creditNoteApplication.id, entityId)).limit(1);
      if (row) {
        return {
          what: `Credit note ${row.note} used on invoice ${work.documentNumber(row.prefix, row.invoice)}`,
          entityType: "credit_note", entityId: row.noteId, flagged: true,
          instead: "or leave it out there if the credit should not have been used on that invoice, and correct the credit note here",
        };
      }
      /** The one settlement a void makes is keyed by the credit note itself. */
      const [note] = await tx.select({ number: schema.creditNote.number }).from(schema.creditNote)
        .where(eq(schema.creditNote.id, entityId)).limit(1);
      return {
        what: note ? `The settlement of voided credit note ${note.number}` : "A credit note used on an invoice",
        entityType: note ? "credit_note" : null, entityId: note ? entityId : null,
        instead: "or settle it there by hand",
      };
    }
    case "credit_note":
    case "credit_note_void": {
      const [row] = await tx.select({ number: schema.creditNote.number }).from(schema.creditNote)
        .where(eq(schema.creditNote.id, entityId)).limit(1);
      const noun = kind === "credit_note" ? "Credit note" : "The invoice reversing voided credit note";
      return {
        what: row ? `${noun} ${row.number}` : "A credit note",
        entityType: row ? "credit_note" : null, entityId: row ? entityId : null,
        instead: "or leave it out there if it should not be in the books",
      };
    }
    case "credit_note_refund": {
      const [row] = await tx.select({ noteId: schema.creditNote.id, number: schema.creditNote.number })
        .from(schema.creditNotePayout)
        .innerJoin(schema.creditNote, eq(schema.creditNote.id, schema.creditNotePayout.creditNoteId))
        .where(eq(schema.creditNotePayout.id, entityId)).limit(1);
      return {
        what: row ? `Credit note ${row.number} paid back to the customer` : "Credit paid back to a customer",
        entityType: row ? "credit_note" : null, entityId: row?.noteId ?? null,
        instead: "or leave it out there if the money never went back",
      };
    }
    case "invoice":
    case "credit_memo": {
      const [row] = await tx.select({ number: schema.invoice.number, prefix: schema.invoice.numberPrefix })
        .from(schema.invoice).where(eq(schema.invoice.id, entityId)).limit(1);
      const number = row ? work.documentNumber(row.prefix, row.number) : null;
      return {
        what: kind === "invoice"
          ? (number ? `Invoice ${number}` : "An invoice")
          : (number ? `The void or write off of invoice ${number}` : "An invoice's void or write off"),
        entityType: row ? "invoice" : null, entityId: row ? entityId : null,
        instead: "or void or credit it here if it should not be owed",
      };
    }
    case "payment": {
      const [row] = await tx.select({ customerId: schema.payment.customerId }).from(schema.payment)
        .where(eq(schema.payment.id, entityId)).limit(1);
      return {
        what: "A payment",
        entityType: row ? "customer" : null, entityId: row?.customerId ?? null,
        instead: "or refund or correct it here if the money did not arrive",
      };
    }
    case "customer": {
      const [row] = await tx.select({ name: schema.customer.name }).from(schema.customer)
        .where(eq(schema.customer.id, entityId)).limit(1);
      return {
        what: row ? `The customer ${row.name}` : "A customer",
        entityType: row ? "customer" : null, entityId: row ? entityId : null,
        instead: "or leave them out there if they should not be in the books",
      };
    }
  }
}

/**
 * Mark one link deleted in the books, once, with a task for the bookkeeper.
 *
 * Only a link that was `linked` moves: one already `deleted` was noticed on an
 * earlier pass and has its task, and one that never reached the books has
 * nothing over there to delete. Called inside the sync's own guarded write,
 * so the flag and the task land together or not at all.
 */
export async function noticeDeleted(
  tx: Database,
  organizationId: string,
  link: { id: string; kind: AccountingEntityKind; entityId: string; provider: string },
): Promise<boolean> {
  const books = booksName(link.provider);
  const [moved] = await tx.update(schema.accountingEntityLink).set({
    state: "deleted",
    lastError: `This document was deleted in the accounting system (${books}).`,
    deletedNoticedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(schema.accountingEntityLink.id, link.id),
    eq(schema.accountingEntityLink.state, "linked"),
  )).returning({ id: schema.accountingEntityLink.id });
  if (!moved) return false;

  const about = await describe(tx, link.kind, link.entityId);
  const [task] = await tx.insert(schema.task).values({
    organizationId,
    title: `${about.what} was deleted in ${books}`,
    body: `It had been sent to ${books}, and somebody deleted it there. Nothing has been sent again or reversed here. `
      + `If the books should have it, send it again ${about.flagged
        ? "with the button beside the note on the record"
        : "from the accounting problems list"} ${about.instead}.`,
    priority: "high",
    entityType: about.entityType,
    entityId: about.entityId,
    queue: "books",
  }).returning({ id: schema.task.id });
  await tx.update(schema.accountingEntityLink).set({ deletionTaskId: task!.id })
    .where(eq(schema.accountingEntityLink.id, link.id));
  return true;
}
