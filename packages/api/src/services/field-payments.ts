import { and, asc, eq, inArray } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { assertCan, can, money as m, type Actor } from "@opentradesos/core";
import type { z } from "zod";
import { guardedWrite, ConflictError, NotFoundError, type ServiceContext } from "./context";
import * as invoiceDelivery from "./invoice-delivery";
import { sendTransactional } from "./comms-send";
import type { visitPaymentLink } from "../contracts/field";

/**
 * A CARD, TAKEN ON SITE, WITHOUT THE PHONE EVER SEEING IT
 *
 * The phone does not take card numbers and is not going to: a technician's
 * phone holding a customer's card details is a compliance problem no trades
 * company should be handed by default. What the product already has is the
 * invoice link a customer pays from with their own phone, and this is that
 * link, fetched for the job in front of the technician, texted to the
 * customer or handed to the phone's share sheet so the customer opens it
 * there and then.
 *
 * The payment lands the way it does for an emailed invoice: the card
 * processor's signed webhook is the only thing that says money moved. So the
 * phone shows the balance falling when it next fetches the day, not when the
 * customer presses pay, and that is the honest order of events.
 *
 * Cash and checks are not here. They are facts recorded offline, through the
 * queue, as `payment.collect` (see `field.ts`), because the money is in the
 * technician's hand whether or not there is a signal.
 */

/**
 * The one extra permission the link needs, added for this call only.
 *
 * Minting an invoice link is `invoice:send`, which a technician does not hold
 * and should not: it would let them mail any customer any invoice. Here the
 * authority is narrower and already checked, the technician is on this
 * visit, so the send is made with that one permission added. Added to
 * `grants`, so a company that has explicitly REVOKED it from this person still
 * wins, the same construction `invoice-delivery` uses for its transport.
 */
function withInvoiceSend(ctx: ServiceContext, actor: Actor): ServiceContext {
  return { ...ctx, actor: { ...actor, grants: [...(actor.grants ?? []), "invoice:send"] } };
}

export async function paymentLink(
  ctx: ServiceContext,
  input: z.infer<typeof visitPaymentLink.input>,
): Promise<z.infer<typeof visitPaymentLink.output>> {
  return guardedWrite(ctx, "payment:collect", async (tx) => {
    const [visit] = await tx.select({
      id: schema.visit.id,
      jobId: schema.visit.jobId,
      customerId: schema.job.customerId,
      customerPhone: schema.customer.phone,
    }).from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .where(eq(schema.visit.id, input.id)).limit(1);
    if (!visit) throw new NotFoundError("Visit");

    /**
     * THE NARROW RULE. The technician on this visit, or somebody who may send
     * invoices anyway. Anybody else holding only `payment:collect` would
     * otherwise be able to mint a link to any job's invoice by guessing a
     * visit id.
     */
    const onIt = ctx.actor.technicianId
      ? (await tx.select({ id: schema.visitAssignment.id }).from(schema.visitAssignment)
        .where(and(
          eq(schema.visitAssignment.visitId, visit.id),
          eq(schema.visitAssignment.technicianId, ctx.actor.technicianId),
        )).limit(1)).length > 0
      : false;
    if (!onIt) assertCan(ctx.actor, "invoice:send");

    const [invoice] = await tx.select({
      id: schema.invoice.id,
      number: schema.invoice.number,
      balance: schema.invoice.balance,
    }).from(schema.invoice)
      .where(and(
        eq(schema.invoice.jobId, visit.jobId),
        inArray(schema.invoice.status, ["open", "partially_paid"]),
      ))
      .orderBy(asc(schema.invoice.issuedOn), asc(schema.invoice.number));
    if (!invoice || !m.isPositive(m.money(invoice.balance))) {
      throw new ConflictError(
        "There is no invoice with money owing on this job yet, so there is nothing for a link to pay. "
        + "Ask the office to raise one, or take cash or a check.",
      );
    }

    if (!(await invoiceDelivery.processorConnected(tx))) {
      throw new ConflictError(
        "This company has not connected card payments, so a link cannot take a card. Take cash or a check.",
      );
    }

    const sent = await invoiceDelivery.send(withInvoiceSend({ ...ctx, db: tx }, ctx.actor), {
      invoiceId: invoice.id,
      channel: "portal_link",
      /**
       * Asked for on purpose. The guard against a second send is for a
       * double click mailing a customer twice; a technician asking for the
       * link with the customer stood beside them is asking for it again.
       */
      resend: true,
    });

    const amountDue = m.toString(m.money(invoice.balance));

    /**
     * A replayed request answers with no link, because only the link's hash
     * is kept and the first answer was the only copy. Said in words, and not
     * texted twice.
     */
    if (sent.portalUrl === "") {
      return {
        url: "", invoiceId: invoice.id, invoiceNumber: invoice.number, amountDue,
        texted: false,
        reason: "That link was already made for this request. Ask for a new one to see it again.",
      };
    }

    let texted = false;
    let reason: string | null = null;
    if (input.text) {
      if (!can(ctx.actor, "message:send")) {
        reason = "Your account may not text customers. Show them the link instead.";
      } else if (!visit.customerPhone) {
        reason = "There is no phone number on this customer. Show them the link instead.";
      } else {
        const [company] = await tx.select({ name: schema.organization.name })
          .from(schema.organization).where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
        const outcome = await sendTransactional(tx, {
          organizationId: ctx.actor.organizationId,
          address: visit.customerPhone,
          body: `${company?.name ?? "Your service company"}: you can pay invoice ${invoice.number} `
            + `(${m.format(m.money(invoice.balance))}) by card here: ${sent.portalUrl}`,
          customerId: visit.customerId,
          sentByUserId: ctx.actor.userId,
        });
        texted = outcome.sent;
        reason = outcome.sent ? null : outcome.explanation;
      }
    }

    return {
      url: sent.portalUrl,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amountDue,
      texted,
      reason,
    };
  });
}
