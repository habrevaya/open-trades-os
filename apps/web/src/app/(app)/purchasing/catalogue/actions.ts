"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { vendorCatalogue } from "@opentradesos/api/services";
import { applyVendorCatalogue, previewVendorCatalogue } from "@opentradesos/api/contracts";
import { field, parsed, refusalOf, refused, type FormState } from "@/lib/actions";
import { rateFromPercent } from "@/lib/estimate-form";

export type CatalogueState = (NonNullable<FormState> & {
  preview?: Awaited<ReturnType<typeof vendorCatalogue.preview>>;
  applied?: Awaited<ReturnType<typeof vendorCatalogue.apply>>;
}) | null;

/** The options both steps read from the same form, so the apply is exactly what was previewed. */
function options(form: FormData) {
  const margin = field(form, "marginPercent");
  return {
    csv: String(form.get("csv") ?? ""),
    vendorId: field(form, "vendorId") ?? null,
    margin: margin ? rateFromPercent(margin) : null,
    ending: field(form, "ending") ?? null,
    updateItemCost: form.get("updateItemCost") === "on",
    categoryId: field(form, "categoryId") ?? null,
  };
}

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** `POST /v1/vendor-catalogue/preview`: what each row would do, with nothing written. */
export async function previewCatalogue(_previous: CatalogueState, form: FormData): Promise<CatalogueState> {
  try {
    const preview = await vendorCatalogue.preview(await ctx(), parsed(previewVendorCatalogue.input, options(form)));
    return { preview };
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
}

/**
 * `POST /v1/vendor-catalogue/apply`, with every row the person unticked
 * left out. The plan is recomputed inside the write, so a row that changed
 * since the preview is written as it now stands.
 */
export async function applyCatalogue(_previous: CatalogueState, form: FormData): Promise<CatalogueState> {
  try {
    const kept = new Set(form.getAll("keep").map(String));
    const skipLines = form.getAll("line").map(String).filter((line) => !kept.has(line)).map(Number);
    const applied = await vendorCatalogue.apply(await ctx(),
      parsed(applyVendorCatalogue.input, { ...options(form), skipLines }));
    revalidatePath("/pricebook");
    revalidatePath("/purchasing");
    return { done: true, applied };
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
}
