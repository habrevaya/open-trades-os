"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements } from "@opentradesos/api/services";
import { createAgreementPlan, updateAgreementPlan } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { planFromForm } from "@/lib/plan-form";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** `POST /v1/agreement-plans`, from the form on the plans screen. */
export async function definePlan(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const result = await attempt(form, async () => {
    const input = parsed(createAgreementPlan.input, planFromForm(form));
    id = (await agreements.createPlan(await ctx(), input)).id;
  });
  if (!id) return result;
  revalidatePath("/agreements/plans");
  redirect(`/agreements/plans/${id}`);
}

/** `PATCH /v1/agreement-plans/{id}`, every field the form shows. */
export async function editPlan(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const input = parsed(updateAgreementPlan.input, { id, ...planFromForm(form, { editing: true }) });
    await agreements.updatePlan(await ctx(), input);
  });
  revalidatePath(`/agreements/plans/${id}`);
  revalidatePath("/agreements/plans");
  return result;
}

/** Retire it, or put a retired plan back on sale. */
export async function setPlanOnSale(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const onSale = form.get("active") === "1";
    if (onSale) await agreements.updatePlan(await ctx(), { id, active: true });
    else await agreements.retirePlan(await ctx(), { id });
  });
  revalidatePath(`/agreements/plans/${id}`);
  revalidatePath("/agreements/plans");
  return result;
}
