"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { journals, budgets } from "@opentradesos/api/services";
import { createJournalEntry, importBudget, setBudgetLine } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { JOURNAL_ROWS } from "./rows";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });


/**
 * A manual journal from the form: up to eight rows, each an account and an
 * amount on one side. Empty rows are left out; the service refuses an entry
 * that does not balance and says which line is wrong.
 */
export async function postJournal(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const lines = Array.from({ length: JOURNAL_ROWS }, (_, i) => ({
      accountCode: field(form, `account:${i}`),
      debit: field(form, `debit:${i}`)?.replace(/[$,\s]/g, ""),
      credit: field(form, `credit:${i}`)?.replace(/[$,\s]/g, ""),
      memo: field(form, `memo:${i}`),
    })).filter((line) => line.accountCode || line.debit || line.credit);
    const input = parsed(createJournalEntry.input, {
      occurredOn: field(form, "occurredOn"), memo: field(form, "memo") ?? "", lines,
    });
    const entry = await journals.create(await ctx(), input);
    return { message: `Posted as journal ${entry.number}.` };
  });
  revalidatePath("/books");
  return result;
}

export async function reverseJournal(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const entry = await journals.reverse(await ctx(), { id: field(form, "id") ?? "" });
    return { message: `Reversed by journal ${entry.number}.` };
  });
  revalidatePath("/books");
  return result;
}

/** One budget line's twelve months, from the grid. */
export async function saveBudgetLine(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(setBudgetLine.input, {
      year: field(form, "year"),
      line: field(form, "line") ?? "",
      amounts: Array.from({ length: 12 }, (_, i) => field(form, `month:${i + 1}`) ?? null),
    });
    await budgets.setLine(await ctx(), input);
  });
  revalidatePath("/books/budget");
  return result;
}

/** A year's budget from a spreadsheet, pasted or uploaded. */
export async function importBudgetFile(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const file = form.get("file");
    const text = file instanceof File && file.size > 0 ? await file.text() : field(form, "csv") ?? "";
    const input = parsed(importBudget.input, { year: field(form, "year"), csv: text });
    const done = await budgets.importCsv(await ctx(), input);
    return { message: `Loaded ${done.lines} ${done.lines === 1 ? "line" : "lines"}, ${done.cells} months.` };
  });
  revalidatePath("/books/budget");
  return result;
}
