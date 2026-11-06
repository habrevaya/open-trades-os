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

/**
 * The options both steps read from the same form, so the apply is exactly what was previewed.
 * The file is a workbook when an .xlsx or .ods came with the form (the sheet chosen beside it), and
 * the pasted or picked CSV text otherwise. A name can lie, so the service still checks what is inside.
 */
async function options(form: FormData) {
  const margin = field(form, "marginPercent");
  const upload = form.get("workbook");
  const book = upload instanceof File && upload.size > 0 ? upload : null;
  const sheet = field(form, "sheet");
  return {
    ...(book
      ? { workbook: Buffer.from(await book.arrayBuffer()).toString("base64"), ...(sheet ? { sheet } : {}) }
      : { csv: String(form.get("csv") ?? "") }),
    vendorId: field(form, "vendorId") ?? null,
    margin: margin ? rateFromPercent(margin) : null,
    ending: field(form, "ending") ?? null,
    updateItemCost: form.get("updateItemCost") === "on",
    categoryId: field(form, "categoryId") ?? null,
    createVendors: form.get("createVendors") === "on",
  };
}

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** `POST /v1/vendor-catalogue/preview`: what each row would do, with nothing written. */
export async function previewCatalogue(_previous: CatalogueState, form: FormData): Promise<CatalogueState> {
  try {
    const preview = await vendorCatalogue.preview(await ctx(), parsed(previewVendorCatalogue.input, await options(form)));
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
      parsed(applyVendorCatalogue.input, { ...(await options(form)), skipLines }));
    revalidatePath("/pricebook");
    revalidatePath("/purchasing");
    return { done: true, applied };
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
}

export type CatalogueSheets =
  | { ok: true; sheets: Array<{ name: string; rows: number | null; header: string[]; why: string | null }> }
  | { ok: false; refusal: string };

/**
 * `POST /v1/vendor-catalogue/sheets`: the sheets of a workbook, asked for as soon
 * as one is chosen so the form can offer them. The workbook is sent again, with
 * the sheet, when the form is.
 */
export async function readCatalogueSheets(form: FormData): Promise<CatalogueSheets> {
  const upload = form.get("file");
  if (!(upload instanceof File) || upload.size === 0) return { ok: false, refusal: "Choose the file to bring in." };
  try {
    const { sheets } = await vendorCatalogue.sheets(await ctx(), {
      workbook: Buffer.from(await upload.arrayBuffer()).toString("base64"),
    });
    return { ok: true, sheets };
  } catch (error) {
    const said = refusalOf(error);
    if (said === null) throw error;
    return { ok: false, refusal: said };
  }
}
