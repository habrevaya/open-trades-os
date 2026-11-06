"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ConflictError, deposits } from "@opentradesos/api/services";
import { applyDeposit, refundDeposit } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** Only a page of this app is shown again, never an address somebody posted. */
function backTo(form: FormData): string | null {
  const back = field(form, "back");
  return back && back.startsWith("/") && !back.startsWith("//") ? back : null;
}

const dollars = (v: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v));

/**
 * PUTTING A HELD DEPOSIT AGAINST AN INVOICE: `POST /v1/deposits/{id}/apply`,
 * the same service call with the same two permissions (`deposit:collect` and
 * `invoice:write`, both checked there) and the same posting. Never more than
 * is held or than the invoice owes, so pressing twice applies nothing the
 * second time.
 */
export async function applyHeldDeposit(_previous: FormState, form: FormData): Promise<FormState> {
  const back = backTo(form);
  const result = await attempt(form, async () => {
    const input = parsed(applyDeposit.input, { id: field(form, "depositId"), invoiceId: field(form, "invoiceId") });
    const applied = await deposits.apply(await ctx(), input);
    if (Number(applied.amountApplied) === 0) {
      return { message: "Nothing was applied: the invoice owes nothing, or the deposit has nothing left." };
    }
    const left = Number(applied.deposit.amountReceived) - Number(applied.deposit.amountApplied);
    return {
      message: `Applied ${dollars(applied.amountApplied)} to the invoice.${left > 0 ? ` ${dollars(String(left))} is still held.` : ""}`,
    };
  });
  if (back) revalidatePath(back);
  return result;
}

/**
 * GIVING A DEPOSIT BACK OR KEEPING IT: `POST /v1/deposits/{id}/refund` with
 * the disposition the office chose, under `deposit:refund`, checked by the
 * service. Always everything still held (see the panel for why), and always
 * with a reason, which goes in the audit row.
 */
export async function disposeOfDeposit(_previous: FormState, form: FormData): Promise<FormState> {
  const back = backTo(form);
  const result = await attempt(form, async () => {
    const reason = field(form, "reason");
    if (!reason) throw new ConflictError("Say why, so whoever looks at this deposit later knows.");
    const input = parsed(refundDeposit.input, {
      id: field(form, "depositId"), disposition: field(form, "disposition"), reason,
    });
    const done = await deposits.refund(await ctx(), input);
    return {
      message: done.status === "refunded"
        ? "Recorded as given back. Remember to pay the customer if you have not."
        : "Recorded as kept. It now counts as income.",
    };
  });
  if (back) revalidatePath(back);
  return result;
}
