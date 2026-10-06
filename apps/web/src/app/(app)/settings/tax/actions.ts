"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { taxRates } from "@opentradesos/api/services";
import { createTaxRate, addTaxRateVersion, updateTaxSettings } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * The company's sales tax rates, from Settings and from the setup wizard's tax
 * step, which posts here before setup is finished: hence `requireUser`. Every
 * refusal (a second rate by one name, a percentage that is not one) is the
 * service's sentence under the form.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/settings/tax");
  revalidatePath("/setup/tax");
}

const percentOf = (form: FormData) => (field(form, "percent") ?? "").replace(/[%\s]/g, "");

export async function addRate(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(createTaxRate.input, {
      name: field(form, "name"),
      percent: percentOf(form),
      effectiveFrom: field(form, "effectiveFrom"),
      makeDefault: form.get("makeDefault") === "1",
    });
    await taxRates.create(await ctx(), input);
    return { message: "Rate added." };
  });
  refresh();
  return result;
}

export async function changeRate(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(addTaxRateVersion.input, {
      id: field(form, "id"),
      percent: percentOf(form),
      effectiveFrom: field(form, "effectiveFrom"),
      note: field(form, "note"),
    });
    await taxRates.addVersion(await ctx(), input);
    return { message: "New percentage saved. Invoices already raised keep what they charged." };
  });
  refresh();
  return result;
}

export async function retireRate(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await taxRates.retire(await ctx(), { id: field(form, "id") ?? "" });
    return { message: "Rate retired." };
  });
  refresh();
  return result;
}

export async function saveTaxSettings(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const usual = field(form, "defaultTaxRateId");
    const input = parsed(updateTaxSettings.input, {
      chargesTax: field(form, "chargesTax") !== "no",
      ...(form.has("defaultTaxRateId") ? { defaultTaxRateId: usual ? usual : null } : {}),
    });
    await taxRates.updateSettings(await ctx(), input);
    return { message: "Saved." };
  });
  refresh();
  return result;
}
