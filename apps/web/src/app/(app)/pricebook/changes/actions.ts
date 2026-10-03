"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { repricing } from "@opentradesos/api/services";
import { applyPriceChange } from "@opentradesos/api/contracts";
import { attempt, field, fields, parsed, refused, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Apply the change previewed, to the items left ticked.
 *
 * The service recomputes every price inside its own write rather than taking
 * the numbers on the screen, which may be a minute old. An empty tick list is
 * refused here, because to the service no `itemIds` means "everything the
 * category and search select", which is the opposite of what unticking every
 * box meant.
 */
export async function applyChange(_previous: FormState, form: FormData): Promise<FormState> {
  const itemIds = fields(form, "itemId");
  if (itemIds.length === 0) return refused(form, "Tick at least one item to change.");
  const state = await attempt(form, async () => {
    const input = parsed(applyPriceChange.input, {
      mode: field(form, "mode"),
      value: field(form, "value"),
      ending: field(form, "ending"),
      categoryId: field(form, "categoryId"),
      q: field(form, "q"),
      itemIds,
    });
    const done = await repricing.handlers.applyPriceChange(await ctx(), input);
    return {
      message: `${done.description}: ${done.changed === 1 ? "1 price" : `${done.changed} prices`} changed`
        + (done.skipped.length > 0 ? `, ${done.skipped.length} left as they were.` : "."),
    };
  });
  revalidatePath("/pricebook/changes");
  revalidatePath("/pricebook");
  return state;
}

/**
 * Put every price a change set back as it was, as new versions, and open the
 * undo itself: it lists what it put back and what it left alone, which a
 * message under a button that has just disappeared could not.
 */
export async function undoChange(_previous: FormState, form: FormData): Promise<FormState> {
  let undone: string | null = null;
  const state = await attempt(form, async () => {
    undone = (await repricing.reverse(await ctx(), { id: String(form.get("id") ?? "") })).id;
  });
  revalidatePath("/pricebook/changes");
  revalidatePath("/pricebook");
  if (undone) redirect(`/pricebook/changes/${undone}`);
  return state;
}
