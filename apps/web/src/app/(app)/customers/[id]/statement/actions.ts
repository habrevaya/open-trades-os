"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { statementDelivery } from "@opentradesos/api/services";
import { attempt, field, refused, refusalOf, type FormState } from "@/lib/actions";

type Copy = { contactId?: string; address?: string; channel: "email" | "sms" };

/**
 * The copies ticked on the send form: each of the customer's people by email or
 * by text, and one address or number typed (an at sign makes it an email address,
 * anything else a number to text). The one "Also send a copy to" box is the
 * older single email copy and is read separately.
 */
function copiesFrom(form: FormData): Copy[] {
  const typed = field(form, "copyTyped");
  return [
    ...form.getAll("copyEmail").map((id) => ({ contactId: String(id), channel: "email" as const })),
    ...form.getAll("copyText").map((id) => ({ contactId: String(id), channel: "sms" as const })),
    ...(typed ? [{ address: typed, channel: (typed.includes("@") ? "email" : "sms") as "email" | "sms" }] : []),
  ];
}

/** What happened to each copy, in the words the page says it in. */
function saidCopies(copies: readonly {
  contactName: string | null; destination: string | null; state: "queued" | "refused"; explanation: string | null;
  channel: "email" | "sms";
}[]): string {
  return copies.map((c) => {
    const who = c.contactName ?? c.destination ?? "that address";
    return c.state === "queued"
      ? ` A ${c.channel === "sms" ? "text copy" : "copy"} goes to ${c.contactName ? `${c.contactName} at ${c.destination}` : c.destination}.`
      : ` No copy went${c.contactName || c.destination ? ` to ${who}` : ""}: ${c.explanation ?? "it was refused."}`;
  }).join("");
}

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
      ...(copiesFrom(form).length > 0 ? { copies: copiesFrom(form) } : {}),
    });
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath(`/customers/${id}/statement`);
  if (result.state === "refused") return refused(form, result.explanation ?? "It was not sent.");
  const copied = saidCopies(result.copies);
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
      ...(copiesFrom(form).length > 0 ? { copies: copiesFrom(form) } : {}),
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
    message: `Texted a link to ${result.destination}. It goes out with the next send from the outbox.${saidCopies(result.copies)}`,
  };
}
