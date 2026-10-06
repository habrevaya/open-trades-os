"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { claims } from "@opentradesos/api/services";
import { attempt, field, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** File a claim on a third party's invoice, and open it. */
export async function fileClaim(_previous: FormState, form: FormData): Promise<FormState> {
  let id = "";
  const result = await attempt(form, async () => {
    const claim = await claims.file(await ctx(), {
      invoiceId: field(form, "invoiceId") ?? "",
      externalReference: field(form, "externalReference"),
    });
    id = claim.id;
  });
  if (result?.error) return result;
  redirect(`/invoices/claims/${id}`);
}

export async function decideClaim(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "claimId") ?? "";
  const result = await attempt(form, async () => claims.decide(await ctx(), {
    id,
    outcome: field(form, "outcome") === "denied" ? "denied" : "approved",
    amount: field(form, "amount"),
    note: field(form, "note"),
    externalReference: field(form, "externalReference"),
  }));
  revalidatePath(`/invoices/claims/${id}`);
  return result;
}

export async function recordClaimPayment(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "claimId") ?? "";
  const method = field(form, "method");
  const result = await attempt(form, async () => claims.recordPayment(await ctx(), {
    id,
    amount: field(form, "amount") ?? "",
    method: method === "ach" || method === "card" || method === "other" ? method : "check",
    reference: field(form, "reference"),
  }));
  revalidatePath(`/invoices/claims/${id}`);
  return result;
}
