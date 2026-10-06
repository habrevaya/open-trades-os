"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { portalAccess, ConflictError, NotFoundError } from "@opentradesos/api/services";
import { attempt, field, type FormState, refused } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * End a customer's sign in, one or all of them. The service asks for
 * `portal:revoke`; the page only offers the button to somebody who holds it.
 */
export async function endPortalSessions(_previous: FormState, form: FormData): Promise<FormState> {
  const customerId = field(form, "customerId") ?? "";
  return attempt(form, async () => {
    const sessionId = field(form, "sessionId");
    const { ended } = await portalAccess.endSessions(await ctx(), {
      customerId, ...(sessionId ? { sessionId } : {}),
    });
    revalidatePath(`/customers/${customerId}`);
    return { message: ended === 0 ? "Nothing was open." : ended === 1 ? "Signed out." : `Signed out of ${ended} sign ins.` };
  });
}

/** Let a contact sign in as the customer, or stop them, which also signs them out. */
export async function setContactPortalAccess(_previous: unknown, form: FormData) {
  const customerId = String(form.get("customerId") ?? "");
  try {
    await portalAccess.setContactAccess(await ctx(), {
      id: String(form.get("id") ?? ""), allowed: form.get("allowed") === "yes",
    });
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/customers/${customerId}`);
  return { done: true };
}
