"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, field, refused, refusalOf, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { spreadsheetImports, type ServiceContext } from "@opentradesos/api/services";
import { imports as rules } from "@opentradesos/core";

const ctx = async (): Promise<ServiceContext> => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * A file, uploaded: kept as rows with its columns guessed, and nothing
 * loaded. The next page is where the owner says which column is which.
 */
export async function uploadSpreadsheet(_previous: FormState, form: FormData): Promise<FormState> {
  const kind = field(form, "kind") ?? "";
  const upload = form.get("file");
  if (!rules.isImportKind(kind)) return refused(form, "Choose what the file holds.");
  if (!(upload instanceof File) || upload.size === 0) return refused(form, "Choose the file to bring in.");
  if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(upload.name)) {
    return refused(form, "That is a spreadsheet workbook, not a CSV file. In your spreadsheet program choose Save As or Download, pick CSV, and bring in that file.");
  }
  let made: string | null = null;
  const result = await attempt(form, async () => {
    const started = await spreadsheetImports.start(await ctx(), { kind, fileName: upload.name, csv: await upload.text() });
    made = started.id;
  });
  revalidatePath("/settings/imports");
  if (made) redirect(`/settings/imports/${made}`);
  return result;
}

/**
 * The name a file's records are kept under, from what the owner typed:
 * "Old System" becomes `old-system`, the shape an `externalRef` source has.
 */
function sourceName(typed: string | undefined): string {
  const plain = (typed ?? "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 50);
  return plain || "spreadsheet";
}

export async function saveColumns(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const width = Number(field(form, "width") ?? "0");
  const columns = Array.from({ length: width }, (_, i) => field(form, `column-${i}`) ?? null);
  const saveAs = field(form, "saveAs");
  const result = await attempt(form, async () => {
    await spreadsheetImports.map(await ctx(), {
      id, columns, source: sourceName(field(form, "source")), dayFirst: field(form, "dayFirst") === "1",
      ...(saveAs ? { saveAs } : {}),
    });
    return { message: saveAs ? `Saved, and kept as "${saveAs}" for the next file like this one.` : "Saved. Every row has been read again." };
  });
  revalidatePath(`/settings/imports/${id}`);
  return result;
}

export async function forgetMapping(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await spreadsheetImports.removeMapping(await ctx(), { id: field(form, "id") ?? "" });
  });
  revalidatePath("/settings/imports");
  return result;
}

export type Step =
  | { ok: true; status: string; rows: number; done: number; more: boolean }
  | { ok: false; refusal: string };

/**
 * ONE BATCH, for the progress page, which calls this until there is no more.
 * Not a form: the page drives it in a loop, so it answers with the progress
 * rather than a form's state.
 */
export async function runStep(id: string, step: "check" | "load"): Promise<Step> {
  try {
    const context = await ctx();
    const progress = step === "check"
      ? await spreadsheetImports.check(context, { id })
      : await spreadsheetImports.load(context, { id });
    const c = progress.counts;
    return {
      ok: true,
      status: progress.status,
      rows: progress.rows,
      done: progress.rows - (step === "check" ? c.waiting : c.ready),
      more: progress.more,
    };
  } catch (error) {
    const said = refusalOf(error);
    if (said === null) throw error;
    return { ok: false, refusal: said };
  } finally {
    revalidatePath(`/settings/imports/${id}`);
  }
}
