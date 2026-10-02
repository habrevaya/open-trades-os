"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, payments } from "@opentradesos/api/services";
import { recordPayment, applyPayment, recordRefund, refundPayment } from "@opentradesos/api/contracts";
import { time } from "@opentradesos/core";
import { attempt, field, parsed, refusalOf, type FormState } from "@/lib/actions";
import { allocationsFromForm } from "@/lib/payment-form";
import type { StartPayment } from "@/app/(portal)/start-payment";

const session = async () => {
  const user = await requireSetupUser();
  return { user, ctx: { actor: user.actor, db: getDb() } };
};

/**
 * The day the money arrived, as the midday instant of that day in the
 * company's zone. Today is sent as nothing, so the service stamps the
 * moment; an earlier day goes through the service's rules for back-dated
 * money (a week is ordinary late entry, more is history).
 */
function receivedAtFrom(day: string | undefined, timezone: string): string | undefined {
  if (!day) return undefined;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (day === today) return undefined;
  return time.instantOfLocal(day, 12 * 60, timezone).toISOString();
}

/**
 * RECORDING MONEY THAT ARRIVED: cash, a cheque, a bank transfer.
 *
 * `POST /v1/payments` with the allocations the office typed, one box per
 * open invoice. Boxes left empty apply nothing to that invoice, and
 * whatever the boxes do not account for is held for the customer as a
 * credit (a liability), to be applied later or given back.
 */
export async function recordPaymentFromOffice(_previous: FormState, form: FormData): Promise<FormState> {
  const { user, ctx } = await session();
  const customerId = field(form, "customerId") ?? "";
  const back = field(form, "back");
  const receivedAt = receivedAtFrom(field(form, "receivedOn"), user.organizationTimezone);
  let done = false;
  const result = await attempt(form, async () => {
    const input = parsed(recordPayment.input, {
      customerId,
      method: field(form, "method"),
      amount: (field(form, "amount") ?? "").replace(/[$,\s]/g, ""),
      ...(receivedAt ? { receivedAt } : {}),
      checkNumber: field(form, "checkNumber"),
      notes: field(form, "notes"),
      allocations: allocationsFromForm(form),
    });
    await billing.pay(ctx, input);
    done = true;
  });
  if (!done) return result;
  redirect(back && back.startsWith("/") ? back : `/customers/${customerId}`);
}

/** Applying money held for the customer to their open invoices. No cash moves. */
export async function applyHeld(_previous: FormState, form: FormData): Promise<FormState> {
  const { ctx } = await session();
  const customerId = field(form, "customerId") ?? "";
  const result = await attempt(form, async () => {
    const input = parsed(applyPayment.input, {
      id: field(form, "paymentId"),
      allocations: allocationsFromForm(form),
    });
    await billing.applyPayment(ctx, input);
  });
  revalidatePath(`/customers/${customerId}`);
  return result;
}

/**
 * Giving money back. Cash, a cheque or a transfer went back by hand and is
 * recorded; a card goes back through the processor, and the payment
 * changes when the processor says the money moved.
 */
export async function refund(_previous: FormState, form: FormData): Promise<FormState> {
  const { ctx } = await session();
  const customerId = field(form, "customerId") ?? "";
  const amount = (field(form, "amount") ?? "").replace(/[$,\s]/g, "");
  const result = await attempt(form, async () => {
    if (field(form, "through") === "processor") {
      const input = parsed(refundPayment.input, {
        paymentId: field(form, "paymentId"),
        ...(amount ? { amount } : {}),
        reason: field(form, "reason"),
      });
      await payments.refund(ctx, input);
      return { message: "Asked the card processor to refund it. The payment changes when it confirms." };
    }
    const input = parsed(recordRefund.input, {
      id: field(form, "paymentId"),
      amount,
      method: field(form, "method"),
      checkNumber: field(form, "checkNumber"),
      reason: field(form, "reason") ?? "",
    });
    await billing.recordRefund(ctx, input);
    return undefined;
  });
  revalidatePath(`/customers/${customerId}`);
  return result;
}

/**
 * TAKING A CARD IN THE OFFICE, through the same Payment Element the
 * customer's link uses. The amount is the invoice's balance, read by the
 * service; nothing is marked paid here, only by the processor's signed
 * webhook, exactly as on the customer's side.
 */
export async function startCardPayment(customerId: string, invoiceId: string): Promise<StartPayment> {
  const { ctx } = await session();
  try {
    const started = await payments.intent(ctx, { customerId, invoiceIds: [invoiceId] });
    if (!started.publishableKey) {
      return { ok: false, message: "Stripe is connected without a publishable key, so the card form cannot load. Add it in Settings, Integrations." };
    }
    return {
      ok: true, clientSecret: started.clientSecret, publishableKey: started.publishableKey,
      amount: started.amount, currency: started.currency,
    };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "The card payment could not be started. Try again, or record it another way." };
  }
}
