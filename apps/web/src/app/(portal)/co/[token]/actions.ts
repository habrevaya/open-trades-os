"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { projectChangeOrders } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";

/**
 * Approving a change order from the customer's own device.
 *
 * The address and the browser are read here, never accepted from the page,
 * for the reason the estimate approval gives: a signature record is worth
 * something only if the parts the signer cannot edit came from somewhere
 * else.
 */
export async function approveChange(input: {
  token: string; signerName: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const h = await headers();
  try {
    await projectChangeOrders.approveForCustomer(
      getDb(),
      { token: input.token, signerName: input.signerName, acceptedTerms: true },
      { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim(), userAgent: h.get("user-agent") ?? undefined },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidGrantError") {
      return { ok: false, message: "This link has already been used or has run out. If you have approved this change, you are all set." };
    }
    /**
     * A change that can no longer be agreed as written (the job billed more
     * in the meantime) is said in the company's words, so the customer
     * knows to ask rather than to try again.
     */
    const message = refusalOf(error);
    if (message === null) throw error;
    return { ok: false, message };
  }
  revalidatePath(`/co/${input.token}`);
  return { ok: true };
}

export async function declineChange(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  try {
    await projectChangeOrders.declineForCustomer(getDb(), { token, ...(reason ? { reason } : {}) });
  } catch {
    // A spent link on a decline is not worth interrupting somebody over; the page shows the outcome.
  }
  revalidatePath(`/co/${token}`);
}
