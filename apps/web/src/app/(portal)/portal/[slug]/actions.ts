"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalSignIn } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";
import { requestMeta, setPortalToken } from "@/lib/portal-session";

export type SignInStep =
  | { ok: true; sent: true; expiresInMinutes: number }
  | { ok: true; choose: { id: string; name: string; place: string | null }[] }
  | { ok: false; message: string };

/**
 * The refusals a customer can act on, in their words.
 *
 * Asking too often and a wrong code are the two that happen to real people,
 * and both say what to do next. Anything else is a fault on our side and
 * says so rather than blaming what they typed.
 */
function said(error: unknown): string {
  if (error instanceof Error && error.name === "TooManyRequestsError") {
    return "That is a lot of tries in a short time. Wait a few minutes and try again.";
  }
  if (error instanceof Error && error.name === "SignInRefusedError") return error.message;
  if (error instanceof Error && error.name === "OrganizationSuspendedError") {
    return "Signing in is not available right now. Contact the company directly.";
  }
  return refusalOf(error) ?? "Something went wrong on our side. Try again in a minute.";
}

/**
 * Send a code. The answer is the same whether or not the address is on
 * file, so the page can only ever say "if that is the address we have, a
 * code is on its way".
 */
export async function sendCode(slug: string, address: string, requestKey: string): Promise<SignInStep> {
  try {
    const meta = await requestMeta();
    const sent = await portalSignIn.requestCode(getDb(), { organizationSlug: slug, address }, {
      ...meta, idempotencyKey: requestKey,
    });
    return { ok: true, sent: true, expiresInMinutes: sent.expiresInMinutes };
  } catch (error) {
    return { ok: false, message: said(error) };
  }
}

/**
 * Check the code. Right, and the cookie is set and the customer lands on
 * their account; right but the address is on two records, and they choose.
 */
export async function checkCode(
  slug: string, address: string, code: string, customerId?: string,
): Promise<SignInStep> {
  let token: string;
  try {
    const verdict = await portalSignIn.verifyCode(getDb(), {
      organizationSlug: slug, address, code, ...(customerId ? { customerId } : {}),
    }, await requestMeta());
    if (verdict.status === "choose") return { ok: true, choose: verdict.accounts };
    token = verdict.token;
  } catch (error) {
    return { ok: false, message: said(error) };
  }
  await setPortalToken(slug, token);
  redirect(`/portal/${encodeURIComponent(slug)}/account`);
}
