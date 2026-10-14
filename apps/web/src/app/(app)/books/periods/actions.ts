"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { accounting } from "@opentradesos/api/services";
import { closeAccountingPeriod, reopenAccountingPeriod } from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";
import { formatDay } from "@/lib/dates";

/**
 * BOOKS → CLOSING THE BOOKS, THE WRITES
 *
 * Through the service `POST /v1/accounting/periods/close` and `/reopen`
 * call, so `accounting:close`, the audit entry and every refusal are the
 * same ones: a day on or before the close already in force, a day that has
 * not come yet, reopening a month nobody closed. Only what a form can leave
 * out is said here first, in words, before the contract's parse would say it
 * as a field name.
 */
const PATH = "/books/periods";

export async function closePeriod(_previous: FormState, form: FormData): Promise<FormState> {
  const periodEnd = field(form, "periodEnd");
  if (!periodEnd) return refused(form, "Choose the last day to close.");
  const user = await requireSetupUser();
  const state = await attempt(form, async () => {
    const input = parsed(closeAccountingPeriod.input, { periodEnd, note: field(form, "note") });
    const closed = await accounting.closePeriod({ actor: user.actor, db: getDb() }, input);
    return { message: `Closed through ${formatDay(closed.periodEnd, user.organizationTimezone)}.` };
  });
  if (!state?.error) revalidatePath(PATH);
  return state;
}

export async function reopenPeriod(_previous: FormState, form: FormData): Promise<FormState> {
  const reason = field(form, "reason");
  if (!reason) return refused(form, "Say why it is being reopened. The reason stays on the record.");
  const user = await requireSetupUser();
  const state = await attempt(form, async () => {
    const input = parsed(reopenAccountingPeriod.input, { periodEnd: field(form, "periodEnd"), reason });
    await accounting.reopenPeriod({ actor: user.actor, db: getDb() }, input);
  });
  if (!state?.error) revalidatePath(PATH);
  return state;
}
