"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { portal } from "@opentradesos/api/services";

/**
 * Approving, from the customer's own device.
 *
 * The address and user agent are read here rather than accepted from the
 * client, for the obvious reason: a signature record is only worth anything if
 * the parts of it the signer cannot edit actually came from somewhere else.
 */
export async function approve(input: {
  token: string;
  optionId: string;
  selectedLineIds: string[];
  signerName: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const h = await headers();

  try {
    await portal.approveEstimate(
      getDb(),
      { ...input, acceptedTerms: true },
      {
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim(),
        userAgent: h.get("user-agent") ?? undefined,
      },
    );
  } catch (error) {
    // The link is single use, so the common failure is a second tab or a
    // double tap rather than anything sinister. Say what happened plainly.
    const message = error instanceof portal.InvalidGrantError
      ? "This link has already been used. If you have approved this estimate, you are all set."
      : "Something went wrong approving this. Please reply to the message that brought you here.";
    return { ok: false, message };
  }

  revalidatePath(`/e/${input.token}`);
  return { ok: true };
}

export async function decline(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  try {
    await portal.declineEstimate(getDb(), {
      token,
      ...(reason ? { reason } : {}),
    });
  } catch {
    // A decline that fails because the link is spent is not worth interrupting
    // someone over: they are declining, and the page will show the outcome.
  }

  revalidatePath(`/e/${token}`);
}
