"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { statementDelivery } from "@opentradesos/api/services";
import { field, refused, refusalOf, type FormState } from "@/lib/actions";

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
  let result;
  try {
    result = await statementDelivery.emailStatement({ actor: user.actor, db: getDb() }, {
      id,
      ...(address ? { email: address } : {}),
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
    message: `Emailed a link to ${result.destination}. It goes out with the next send from the outbox.`,
  };
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
