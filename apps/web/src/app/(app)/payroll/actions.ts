"use server";

import { refused, type FormState } from "@/lib/actions";
import { keptForm, type Kept } from "@/lib/kept-values";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { payroll, ConflictError, NotFoundError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export type PayrollState = FormState;

/**
 * Every refusal on this path is the service's own sentence: a period that
 * cuts a workweek, a close with a punch still open, an export of a period
 * whose punches moved after it closed. Shown, not thrown.
 */
async function attempt(form: FormData, run: () => Promise<unknown>, path: string): Promise<PayrollState> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) return refused(form, error.message);
    if (error instanceof Error && error.name === "UnprocessableError") return refused(form, error.message);
    throw error;
  }
  revalidatePath(path);
  return { done: true };
}

export async function declare(_previous: PayrollState, form: FormData): Promise<PayrollState> {
  return attempt(form, async () => payroll.declarePeriod(await ctx(), {
    label: String(form.get("label") ?? "").trim(),
    startDate: String(form.get("startDate") ?? ""),
    weeks: Number(form.get("weeks") ?? 1),
  }), "/payroll");
}

export async function close(_previous: PayrollState, form: FormData): Promise<PayrollState> {
  const periodId = String(form.get("periodId") ?? "");
  const note = String(form.get("note") ?? "").trim();
  return attempt(form, async () => payroll.closePeriod(await ctx(), { periodId, ...(note ? { note } : {}) }),
    `/payroll/${periodId}`);
}

export async function reopen(_previous: PayrollState, form: FormData): Promise<PayrollState> {
  const periodId = String(form.get("periodId") ?? "");
  return attempt(form, async () => payroll.reopenPeriod(await ctx(), {
    periodId, reason: String(form.get("reason") ?? "").trim(),
  }), `/payroll/${periodId}`);
}

export async function payOut(_previous: PayrollState, form: FormData): Promise<PayrollState> {
  const periodId = String(form.get("periodId") ?? "");
  return attempt(form, async () => payroll.payCommissions(await ctx(), { periodId }), `/payroll/${periodId}`);
}

/** Pass on the tips held for technicians, which clears what the company owed them. */
export async function payOutTips(_previous: PayrollState, form: FormData): Promise<PayrollState> {
  const periodId = String(form.get("periodId") ?? "");
  return attempt(form, async () => payroll.payTips(await ctx(), { periodId }), `/payroll/${periodId}`);
}

export type ExportState =
  | { file: { name: string; content: string; checksum: string; previouslyExported: boolean } }
  | { error: string; values: Kept }
  | null;

/**
 * The CSV comes back to the browser as text and is saved from there. The
 * service records the export either way, so the list below the button is
 * the record of what left the building, not the download.
 */
export async function exportCsv(_previous: ExportState, form: FormData): Promise<ExportState> {
  const periodId = String(form.get("periodId") ?? "");
  try {
    const result = await payroll.exportPeriod(await ctx(), { periodId });
    revalidatePath(`/payroll/${periodId}`);
    return {
      file: {
        name: `payroll-${String(form.get("label") ?? periodId).replace(/[^A-Za-z0-9-]+/g, "-")}.csv`,
        content: result.content,
        checksum: result.checksum,
        previouslyExported: result.previouslyExported,
      },
    };
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) return { error: error.message, values: keptForm(form) };
    throw error;
  }
}
