"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { creditNotes } from "@opentradesos/api/services";
import { createCreditNote, applyCreditNote } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * CREDITING AN INVOICE, from the invoice.
 *
 * One box per line, for how much comes off it. Empty boxes are lines nobody
 * is crediting. The service prices it, takes the tax at the rate the line
 * charged, refuses more than the line billed, and applies it to this
 * invoice's balance straight away.
 */
export async function creditInvoice(_previous: FormState, form: FormData): Promise<FormState> {
  const invoiceId = field(form, "invoiceId") ?? "";
  let id: string | null = null;
  const result = await attempt(form, async () => {
    const lines = [...form.keys()]
      .filter((k) => k.startsWith("line:"))
      .map((k) => ({ invoiceLineId: k.slice(5), unitPrice: field(form, k) }))
      .filter((l): l is { invoiceLineId: string; unitPrice: string } => Boolean(l.unitPrice))
      .map((l) => ({ ...l, quantity: "1" }));
    if (lines.length === 0) {
      return { message: "Put an amount against at least one line." };
    }
    const input = parsed(createCreditNote.input, {
      invoiceId, reason: field(form, "reason"), note: field(form, "note"), lines,
    });
    id = (await creditNotes.create(await ctx(), input)).id;
    return undefined;
  });
  if (!id) return result;
  revalidatePath(`/invoices/${invoiceId}`);
  redirect(`/invoices/credit-notes/${id}`);
}

/** A credit that is not about one invoice: goodwill, the end of a contract. */
export async function giveCredit(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const result = await attempt(form, async () => {
    const input = parsed(createCreditNote.input, {
      customerId: field(form, "customerId"),
      reason: field(form, "reason"),
      note: field(form, "note"),
      lines: [{ name: field(form, "name"), unitPrice: field(form, "amount"), quantity: "1" }],
    });
    id = (await creditNotes.create(await ctx(), input)).id;
  });
  if (!id) return result;
  redirect(`/invoices/credit-notes/${id}`);
}

/** Everything done to a credit note once it exists, named by `op`. */
export async function actOnCreditNote(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "creditNoteId") ?? "";
  const op = field(form, "op");
  const c = await ctx();
  let deleted = false;
  const result = await attempt(form, async () => {
    switch (op) {
      case "issue":
        await creditNotes.issue(c, { id, apply: true });
        return;
      case "delete":
        await creditNotes.deleteDraft(c, { id });
        deleted = true;
        return;
      case "void":
        await creditNotes.voidNote(c, { id, reason: field(form, "reason") ?? "" });
        return;
      case "apply": {
        const input = parsed(applyCreditNote.input, {
          id, applications: [{ invoiceId: field(form, "invoiceId"), amount: field(form, "amount") }],
        });
        await creditNotes.apply(c, input);
        return;
      }
      default:
        throw new Error(`Unknown credit note operation ${String(op)}`);
    }
  });
  if (deleted) redirect("/invoices/credit-notes");
  revalidatePath(`/invoices/credit-notes/${id}`);
  return result;
}
