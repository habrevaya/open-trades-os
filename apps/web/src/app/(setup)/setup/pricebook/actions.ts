"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { repricing } from "@opentradesos/api/services";
import { applyPriceChange } from "@opentradesos/api/contracts";
import { attempt, field, fields, parsed, refused, type FormState } from "@/lib/actions";

/**
 * Apply the re-pricing the step previewed, to the items left ticked, through
 * the same bulk change Price book, Change prices makes: a new version per
 * item, recomputed inside the write, listed afterwards with an undo.
 * `requireUser`, because this runs before setup is finished.
 */
export async function applyMarketChange(_previous: FormState, form: FormData): Promise<FormState> {
  const itemIds = fields(form, "itemId");
  if (itemIds.length === 0) return refused(form, "Tick at least one item to change.");
  const state = await attempt(form, async () => {
    const input = parsed(applyPriceChange.input, {
      mode: field(form, "mode"),
      value: field(form, "value"),
      ending: field(form, "ending"),
      categoryId: field(form, "categoryId"),
      itemIds,
    });
    const done = await repricing.handlers.applyPriceChange({ actor: (await requireUser()).actor, db: getDb() }, input);
    return {
      message: `${done.description}: ${done.changed === 1 ? "1 price" : `${done.changed} prices`} changed. `
        + "It is listed under Price book, Change prices, with a button that puts it back.",
    };
  });
  revalidatePath("/setup/pricebook");
  revalidatePath("/pricebook");
  return state;
}
