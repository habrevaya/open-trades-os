"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, field, refused, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects } from "@opentradesos/api/services";
import { customFieldsFrom } from "@/lib/custom-field-form";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * What a record points at, from the form: the ids a page carried in (the job
 * a permit was added from), or a job by its number when somebody typed one.
 */
async function linksFrom(form: FormData) {
  const links: Record<string, string> = {};
  for (const name of ["customerId", "propertyId", "jobId", "equipmentId", "invoiceId", "membershipId", "linkedRecordId"]) {
    const value = field(form, name);
    if (value) links[name] = value;
  }
  const number = field(form, "jobNumber");
  if (number && !links["jobId"]) {
    const id = /^\d+$/.test(number) ? await customObjects.jobByNumber(await ctx(), { number: Number(number) }) : null;
    if (!id) return { links, problem: `There is no job ${number} you can see.` };
    links["jobId"] = id;
  }
  return { links, problem: null };
}

/** Where to go after saving: the page it was added from, or the record. */
const back = (form: FormData, fallback: string) => {
  const from = field(form, "back");
  return from && from.startsWith("/") && !from.startsWith("//") ? from : fallback;
};

export async function createRecord(_previous: FormState, form: FormData): Promise<FormState> {
  const type = String(form.get("type") ?? "");
  const { links, problem } = await linksFrom(form);
  if (problem) return refused(form, problem);
  let made: string | null = null;
  const result = await attempt(form, async () => {
    const context = await ctx();
    const kind = await customObjects.getKind(context, { key: type });
    const record = await customObjects.createRecord(context, {
      type, title: field(form, "title") ?? "", customFields: customFieldsFrom(form, kind.fields), ...links,
    });
    made = record.id;
  });
  revalidatePath("/records", "layout");
  if (made) {
    const from = back(form, `/records/${type}/${made}`);
    revalidatePath(from);
    redirect(from);
  }
  return result;
}

export async function updateRecord(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const result = await attempt(form, async () => {
    const context = await ctx();
    const before = await customObjects.getRecord(context, { id });
    await customObjects.updateRecord(context, {
      id, title: field(form, "title") ?? "",
      customFields: customFieldsFrom(form, before.fields, before.customFields),
    });
    return { message: "Saved." };
  });
  revalidatePath("/records", "layout");
  return result;
}

export async function removeRecord(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const type = String(form.get("type") ?? "");
  let gone = false;
  const result = await attempt(form, async () => {
    await customObjects.removeRecord(await ctx(), { id });
    gone = true;
  });
  revalidatePath("/records", "layout");
  if (gone) redirect(`/records/${type}`);
  return result;
}

/**
 * A spreadsheet of records: checked first (the import run and rolled back,
 * which is what the API's dry run does), then loaded, all or nothing.
 */
export async function importRecords(_previous: FormState, form: FormData): Promise<FormState> {
  const type = String(form.get("type") ?? "");
  const upload = form.get("file");
  const typed = field(form, "csv");
  const csv = upload instanceof File && upload.size > 0 ? await upload.text() : typed ?? "";
  if (csv.trim() === "") return refused(form, "Choose a CSV file, or paste one.");
  const check = form.get("check") === "1";
  const context = await ctx();
  const result = await attempt(form, async () => {
    if (check) {
      const tried = await context.db.transaction(async (tx) => {
        const answer = await customObjects.importCsv({ ...context, db: tx as unknown as typeof context.db }, { type, csv });
        throw Object.assign(new Error("rolled back"), { name: "CheckedOnly", answer });
      }).catch((error: unknown) => {
        if (error instanceof Error && error.name === "CheckedOnly") return (error as Error & { answer: { created: number; ignoredColumns: string[] } }).answer;
        throw error;
      });
      return {
        message: `The file is fine: ${tried.created} would be loaded.`
          + (tried.ignoredColumns.length > 0 ? ` Columns nothing reads: ${tried.ignoredColumns.join(", ")}.` : "")
          + " Nothing has been loaded yet.",
      };
    }
    const loaded = await customObjects.importCsv(context, { type, csv });
    return {
      message: `Loaded ${loaded.created}.`
        + (loaded.ignoredColumns.length > 0 ? ` Columns nothing read: ${loaded.ignoredColumns.join(", ")}.` : ""),
    };
  });
  revalidatePath("/records", "layout");
  return result;
}
