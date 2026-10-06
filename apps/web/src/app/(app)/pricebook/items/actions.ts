"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ConflictError, priceBook, vendorCatalogue } from "@opentradesos/api/services";
import {
  createPriceBookItem, revisePriceBookItem, updatePriceBookItem, setPriceBookItemActive, setVendorItem,
} from "@opentradesos/api/contracts";
import { time } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const session = async () => {
  const user = await requireSetupUser();
  return { ctx: { actor: user.actor, db: getDb() }, timezone: user.organizationTimezone };
};

const amount = (value: string | undefined) => value?.replace(/[$,\s]/g, "");
const whole = (value: string | undefined) => (value === undefined ? undefined : Number(value));

/** `POST /v1/pricebook/items`, then the item's own screen. */
export async function createItem(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const result = await attempt(form, async () => {
    const { ctx } = await session();
    const input = parsed(createPriceBookItem.input, {
      kind: field(form, "kind"), code: field(form, "code"), name: field(form, "name"),
      description: field(form, "description"), categoryId: field(form, "categoryId"),
      price: amount(field(form, "price")), cost: amount(field(form, "cost")),
      taxable: form.get("taxable") === "on",
      laborMinutes: whole(field(form, "laborMinutes")), warrantyMonths: whole(field(form, "warrantyMonths")),
      feeRole: field(form, "feeRole"),
    });
    id = (await priceBook.create(ctx, input)).id;
  });
  if (!id) return result;
  revalidatePath("/pricebook");
  redirect(`/pricebook/items/${id}`);
}

/**
 * Everything done to one item, named by `op`, each the call its API route
 * makes: a revision (a new version, now or from a date), what the item is,
 * retiring it, a scheduled revision brought forward or called off, and a
 * vendor's part number added, replaced or forgotten.
 */
export async function actOnItem(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const op = field(form, "op");
  const result = await attempt(form, async () => {
    const { ctx, timezone } = await session();
    switch (op) {
      case "revise": {
        /**
         * A date means from the start of that day in the company's calendar;
         * empty, or a day that has already started, means now. A start in
         * the past would open the new version before the one it closes, and
         * the two windows would overlap.
         */
        const on = field(form, "effectiveOn");
        const start = on ? time.startOfDayIn(on, timezone) : null;
        const from = start && start.getTime() > Date.now() ? on : undefined;
        await priceBook.revise(ctx, parsed(revisePriceBookItem.input, {
          id,
          name: field(form, "name"),
          description: String(form.get("description") ?? "").trim(),
          price: amount(field(form, "price")),
          ...(form.has("cost") ? { cost: amount(field(form, "cost")) } : {}),
          taxable: form.get("taxable") === "on",
          taxClass: field(form, "taxClass") ?? null,
          laborMinutes: whole(field(form, "laborMinutes")),
          warrantyMonths: field(form, "warrantyMonths") === undefined ? null : Number(field(form, "warrantyMonths")),
          ...(from && start ? { effectiveFrom: start.toISOString() } : {}),
        }));
        return { message: from ? `Saved as a new version, in force from ${from}.` : "Saved as a new version, in force now." };
      }
      case "components": {
        /**
         * Each row is a code and a quantity. A code is looked up exactly,
         * not by the search the list uses, so "KV-1" never finds "KV-10".
         */
        const components: { itemId: string; quantity: number }[] = [];
        for (const key of [...form.keys()].filter((k) => k.startsWith("partCode"))) {
          const code = field(form, key)?.trim();
          if (!code) continue;
          const quantity = Number(field(form, `partQuantity${key.slice("partCode".length)}`) ?? "1");
          const found = (await priceBook.list(ctx, { q: code, limit: 20, includeInactive: true })).data
            .find((row) => row.code.toLowerCase() === code.toLowerCase());
          if (!found) throw new ConflictError(`No item in the price book has the code "${code}".`);
          components.push({ itemId: found.id, quantity });
        }
        const on = field(form, "effectiveOn");
        const start = on ? time.startOfDayIn(on, timezone) : null;
        const from = start && start.getTime() > Date.now() ? on : undefined;
        await priceBook.revise(ctx, parsed(revisePriceBookItem.input, {
          id, components, ...(from && start ? { effectiveFrom: start.toISOString() } : {}),
        }));
        return { message: from ? `The parts are saved as a new version, in force from ${from}.` : "The parts are saved as a new version, in force now." };
      }
      case "identity":
        await priceBook.updateItem(ctx, parsed(updatePriceBookItem.input, {
          id, kind: field(form, "kind"), code: field(form, "code"),
          categoryId: field(form, "categoryId") ?? null, feeRole: field(form, "feeRole") ?? null,
        }));
        return { message: "Saved. No version was written: nothing anybody was charged changes." };
      case "active":
        await priceBook.setActive(ctx, parsed(setPriceBookItemActive.input, {
          id, active: form.get("active") === "1", reason: field(form, "reason"),
        }));
        return undefined;
      case "publish":
        await priceBook.publishRevision(ctx, { versionId: field(form, "versionId") ?? "" });
        return undefined;
      case "discard":
        await priceBook.discardRevision(ctx, { versionId: field(form, "versionId") ?? "" });
        return undefined;
      case "vendor":
        await vendorCatalogue.setLink(ctx, parsed(setVendorItem.input, {
          itemId: id, vendorId: field(form, "vendorId"), partNumber: field(form, "partNumber"),
          cost: field(form, "vendorCost") ?? null, description: field(form, "vendorDescription") ?? null,
          ...(field(form, "packQuantity") ? { packQuantity: field(form, "packQuantity") } : {}),
          ...(field(form, "purchaseUnit") ? { purchaseUnit: field(form, "purchaseUnit") } : {}),
        }));
        return { message: "Saved. Purchase orders to this vendor will carry their number." };
      case "unvendor":
        await vendorCatalogue.removeLink(ctx, { id: field(form, "linkId") ?? "" });
        return undefined;
      default:
        throw new Error(`Unknown price book operation ${String(op)}`);
    }
  });
  revalidatePath(`/pricebook/items/${id}`);
  revalidatePath("/pricebook");
  return result;
}
