"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { portalAccount, portalSignIn, savedCards, visitChanges } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";
import { clearPortalToken, portalToken, requestMeta, requirePortalSession } from "@/lib/portal-session";
import { startPaymentFor, type StartPayment } from "../../../start-payment";
import type { SavedCardPay } from "../../../PayInvoice";
import type { VisitChangeResult } from "../../../visit-change-actions";

/**
 * EVERYTHING A SIGNED IN CUSTOMER CAN DO, BOUND TO THE COMPANY AND NOTHING
 * ELSE.
 *
 * Each action is bound on the page to the company's slug (and an invoice or
 * card id where it needs one), and reads the sign in from the cookie here on
 * the server. The token is never handed to the browser in any other form,
 * which is what keeps an HttpOnly cookie worth having: a link page binds its
 * token into its actions because the token is in its URL already, and these
 * pages have no token in theirs.
 *
 * Every id that arrives here is checked by the service against the customer
 * the sign in names; another customer's invoice or card is the same not
 * found as one that does not exist.
 */

const home = (slug: string) => `/portal/${encodeURIComponent(slug)}/account`;

const fault = "Something went wrong on our side. Try again, or contact us to pay another way.";

export async function startSessionPayment(
  slug: string, invoiceId: string, options?: { tip?: string },
): Promise<StartPayment> {
  const session = await requirePortalSession(slug);
  return startPaymentFor((meta) => portalAccount.startInvoicePayment(getDb(), {
    token: session.token, invoiceId, ...(options?.tip ? { tip: options.tip } : {}),
  }, meta));
}

export async function payWithSavedCard(
  slug: string, invoiceId: string, cardId: string, options?: { tip?: string },
): Promise<SavedCardPay> {
  const session = await requirePortalSession(slug);
  try {
    const paid = await savedCards.pay(getDb(), {
      token: session.token, invoiceId, cardId, ...(options?.tip ? { tip: options.tip } : {}),
    }, await requestMeta());
    return { ok: true, status: paid.status, clientSecret: paid.clientSecret, publishableKey: paid.publishableKey };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? fault };
  }
}

export type CardSetupResult =
  | { ok: true; clientSecret: string; publishableKey: string }
  | { ok: false; message: string };

export async function startCardSetup(slug: string, kind: "card" | "bank_account" = "card"): Promise<CardSetupResult> {
  const session = await requirePortalSession(slug);
  try {
    const started = await savedCards.startSave(getDb(), { token: session.token, kind }, await requestMeta());
    if (!started.publishableKey) {
      return { ok: false, message: "Saving a card is not set up yet. You can still pay with a card each time." };
    }
    return { ok: true, clientSecret: started.clientSecret, publishableKey: started.publishableKey };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? fault };
  }
}

export async function removeCard(slug: string, cardId: string): Promise<{ ok: boolean; message?: string }> {
  const session = await requirePortalSession(slug);
  try {
    await savedCards.remove(getDb(), { token: session.token, cardId }, await requestMeta());
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? fault };
  }
  revalidatePath(home(slug));
  return { ok: true };
}

/**
 * Open one estimate, job or invoice on its own page: a narrower link,
 * minted for that record and one day, and the browser sent to it.
 */
export async function openRecord(slug: string, kind: "estimate" | "job" | "invoice", id: string): Promise<void> {
  const session = await requirePortalSession(slug);
  const { url } = await portalSignIn.openRecord(getDb(), { token: session.token, kind, id });
  redirect(url);
}

export async function signOut(slug: string): Promise<void> {
  const token = await portalToken();
  if (token) await portalSignIn.signOut(getDb(), { token }).catch(() => undefined);
  await clearPortalToken(slug);
  redirect(`/portal/${encodeURIComponent(slug)}`);
}

/** Asking to move or cancel a visit, as the account link asks, from the sign in. */
export async function requestSessionVisitChange(slug: string, input: {
  visitId?: string | undefined;
  kind: "reschedule" | "cancel";
  requestedDate?: string | undefined;
  arrivalWindowId?: string | undefined;
  reason?: string | undefined;
}): Promise<VisitChangeResult> {
  const session = await requirePortalSession(slug);
  try {
    await visitChanges.request(getDb(), {
      token: session.token,
      ...(input.visitId ? { visitId: input.visitId } : {}),
      kind: input.kind,
      ...(input.requestedDate ? { requestedDate: input.requestedDate } : {}),
      ...(input.arrivalWindowId ? { arrivalWindowId: input.arrivalWindowId } : {}),
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    }, await requestMeta());
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "Something went wrong sending that. Please contact us." };
  }
  if (input.visitId) revalidatePath(`${home(slug)}/change/${input.visitId}`);
  return { ok: true };
}
