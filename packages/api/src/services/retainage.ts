import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { ledger, money as m } from "@opentradesos/core";
import { audit, type ServiceContext } from "./context";
import { writePosting } from "./ledger";

/**
 * RETAINAGE, ON THE BOOKS
 *
 * The customer holds back a share of every application for payment until the
 * job is done. That money is earned when the work is done and billed, and
 * owed later: so the work is revenue in full when it is billed, and the share
 * held back is a receivable of its own (`ACCOUNTS.RETAINAGE_RECEIVABLE`), not
 * money the customer owes yet and so not on their statement or in the aging.
 * When it is released and invoiced it moves off that receivable onto what
 * they owe, and is not earned a second time.
 *
 * The invoice an application becomes is unchanged: it carries what is due
 * now, net of retainage (`core/project.paymentLines`), and `postInvoice`
 * posts it as it posts any invoice. What this file adds is the difference
 * between that and the truth, one posting per application
 * (`ledger.postRetainage`): the retainage it held, or what it released.
 *
 * WORKED OUT FROM WHAT IS ON THE BOOKS, not from the application before it:
 * the change is what the application says is held now, less what this
 * project's applications have already put on the receivable and not taken
 * back. On an ordinary run of applications that is exactly the held share of
 * the invoice; after a void took one application's retainage back off, the
 * next application books it again.
 *
 * A PROJECT BILLED BEFORE THIS BOOKED NOTHING, and is left that way for good.
 * An application invoiced before retainage was booked here has no
 * `retainage_booked`, and its retainage was booked as revenue when it was
 * released and invoiced, which is what the old invoices already say. Starting
 * the receivable halfway through would take released retainage off a
 * receivable it was never put on, so every later application on that project
 * books none either and the release line stays revenue, as before. Only a
 * project with no application invoiced the old way books it here.
 */

export type RetainageBooking = "receivable" | "net";

const usd = (value: string) => m.money(value, "USD");

/**
 * How a project's retainage is booked: on its own receivable, or the old
 * way, revenue when released, for a project an application was invoiced on
 * before this existed.
 */
export async function bookingOf(tx: Database, projectId: string, except?: string): Promise<RetainageBooking> {
  const [old] = await tx.select({ id: schema.projectApplication.id }).from(schema.projectApplication)
    .where(and(
      eq(schema.projectApplication.projectId, projectId),
      eq(schema.projectApplication.status, "invoiced"),
      isNull(schema.projectApplication.retainageBooked),
      except ? ne(schema.projectApplication.id, except) : undefined,
    )).limit(1);
  return old ? "net" : "receivable";
}

/**
 * Book the retainage of an application that has just become an invoice.
 *
 * Called in the transaction that freezes the application, once: a raise
 * retried after it went finds the application frozen and books nothing.
 * Returns what was booked, or null for a project booked the old way.
 */
export async function bookOnInvoice(
  tx: Database, ctx: ServiceContext,
  input: { applicationId: string; projectId: string; customerId: string; totalRetainage: string; at: Date },
): Promise<string | null> {
  if (await bookingOf(tx, input.projectId, input.applicationId) === "net") return null;

  const earlier = await tx.select({ booked: schema.projectApplication.retainageBooked })
    .from(schema.projectApplication)
    .where(and(
      eq(schema.projectApplication.projectId, input.projectId),
      eq(schema.projectApplication.status, "invoiced"),
      ne(schema.projectApplication.id, input.applicationId),
      isNull(schema.projectApplication.retainageReversedAt),
    ))
    .orderBy(asc(schema.projectApplication.number));
  const onBooks = m.sum(earlier.map((row) => usd(row.booked ?? "0")), "USD");
  const change = m.subtract(usd(input.totalRetainage), onBooks);

  if (!m.isZero(change)) {
    await writePosting(tx, ctx, ledger.postRetainage({
      applicationId: input.applicationId, occurredAt: input.at, change, customerId: input.customerId,
    }));
  }
  return m.toString(change);
}

/**
 * The application whose invoice is being voided takes its retainage back
 * off, so a void leaves none of that application's revenue on the books.
 * The application itself stays invoiced, as M12 says, and the next one
 * books whatever is then held. Nothing for an application booked the old way.
 */
export async function reverseOnVoid(tx: Database, ctx: ServiceContext, invoiceId: string): Promise<void> {
  const [row] = await tx.select().from(schema.projectApplication)
    .where(and(
      eq(schema.projectApplication.invoiceId, invoiceId),
      eq(schema.projectApplication.status, "invoiced"),
      isNull(schema.projectApplication.retainageReversedAt),
    ))
    .for("update").limit(1);
  if (!row || row.retainageBooked === null) return;
  const booked = usd(row.retainageBooked);
  const [project] = await tx.select({ customerId: schema.project.customerId }).from(schema.project)
    .where(eq(schema.project.id, row.projectId)).limit(1);
  if (!m.isZero(booked)) {
    await writePosting(tx, ctx, ledger.postRetainage({
      applicationId: row.id, occurredAt: new Date(), change: m.negate(booked),
      customerId: project?.customerId, reversal: true,
    }));
  }
  await tx.update(schema.projectApplication).set({ retainageReversedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.projectApplication.id, row.id));
  await audit(tx, ctx, "project_application.retainage_reversed", "project_application", row.id,
    { retainageBooked: row.retainageBooked }, { invoiceId, reversed: row.retainageBooked });
}
