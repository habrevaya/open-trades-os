"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { statementDelivery } from "@opentradesos/api/services";
import { attempt, field, refused, refusalOf, type FormState } from "@/lib/actions";

/**
 * Email the statement on screen, for the period on screen.
 *
 * A refusal from the outbox (no address, asked not to be emailed, no email
 * connected) comes back as the red sentence under the button rather than as
 * "sent", because the office reading "sent" stops wondering why the customer
 * says they never got it.
 */
export async function emailStatement(_previous: unknown, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const id = String(form.get("id") ?? "");
  const address = field(form, "email");
  const from = field(form, "from");
  const to = field(form, "to");
  const copyContactId = field(form, "copyContactId");
  let result;
  try {
    result = await statementDelivery.emailStatement({ actor: user.actor, db: getDb() }, {
      id,
      ...(address ? { email: address } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(copyContactId ? { copyContactId } : {}),
    });
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath(`/customers/${id}/statement`);
  if (result.state === "refused") return refused(form, result.explanation ?? "It was not sent.");
  const copied = result.copy === null ? ""
    : result.copy.state === "queued" ? ` A copy goes to ${result.copy.contactName ?? "them"} at ${result.copy.destination}.`
      : ` No copy went: ${result.copy.explanation ?? "it was refused."}`;
  return {
    done: true,
    message: `Emailed a link to ${result.destination}. It goes out with the next send from the outbox.${copied}`,
  };
}

/**
 * Name the person every monthly statement is copied to, or nobody. Through
 * the service `PUT /v1/customers/{id}/statement-copy` calls, so the check
 * that they are this customer's own, with an address, is the same one.
 */
export async function setMonthlyCopy(_previous: unknown, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const id = String(form.get("id") ?? "");
  const contactId = field(form, "contactId") ?? null;
  const state = await attempt(form, async () => {
    const saved = await statementDelivery.setStatementCopy({ actor: user.actor, db: getDb() }, { id, contactId });
    return {
      message: saved.name
        ? `Saved. Each monthly statement is copied to ${saved.name}.`
        : "Saved. Monthly statements are copied to nobody.",
    };
  });
  if (!state?.error) revalidatePath(`/customers/${id}/statement`);
  return state;
}

/**
 * Text the statement's link, for the period on screen, through the consent
 * gate every text goes through. A refusal (they replied STOP, no number to
 * text, no number registered to text from) is the red sentence under the
 * button, for the reason the email's is.
 */
export async function textStatement(_previous: unknown, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const id = String(form.get("id") ?? "");
  const phone = field(form, "phone");
  const from = field(form, "from");
  const to = field(form, "to");
  let result;
  try {
    result = await statementDelivery.textStatement({ actor: user.actor, db: getDb() }, {
      id,
      ...(phone ? { phone } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath(`/customers/${id}/statement`);
  if (result.state === "refused") return refused(form, result.explanation ?? "It was not sent.");
  return {
    done: true,
    message: `Texted a link to ${result.destination}. It goes out with the next send from the outbox.`,
  };
}
