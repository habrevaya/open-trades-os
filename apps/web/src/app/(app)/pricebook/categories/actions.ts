"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceCategories } from "@opentradesos/api/services";
import {
  createPriceBookCategory, updatePriceBookCategory, placePriceBookCategory, filePriceBookItems,
} from "@opentradesos/api/contracts";
import { attempt, field, fields, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const done = (state: FormState) => {
  revalidatePath("/pricebook/categories");
  revalidatePath("/pricebook");
  return state;
};

export async function addCategory(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    const input = parsed(createPriceBookCategory.input, {
      name: field(form, "name"), parentId: field(form, "parentId") ?? null,
    });
    await priceCategories.create(await ctx(), { name: input.name, parentId: input.parentId ?? null });
  }));
}

/** Rename, and move under another shelf or to the top. */
export async function editCategory(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    const input = parsed(updatePriceBookCategory.input, {
      id: field(form, "id"), name: field(form, "name"), parentId: field(form, "parentId") ?? null,
    });
    await priceCategories.update(await ctx(), { id: input.id, name: input.name, parentId: input.parentId ?? null });
  }));
}

/** Up or down among its siblings, sent as the position wanted. */
export async function placeCategory(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    const input = parsed(placePriceBookCategory.input, {
      id: field(form, "id"), position: Number(field(form, "position") ?? "0"),
    });
    await priceCategories.place(await ctx(), input);
  }));
}

export async function removeCategory(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    await priceCategories.remove(await ctx(), { id: String(form.get("id") ?? "") });
  }));
}

export async function fileItems(_previous: FormState, form: FormData): Promise<FormState> {
  return done(await attempt(form, async () => {
    const input = parsed(filePriceBookItems.input, {
      itemIds: fields(form, "itemId"), categoryId: field(form, "categoryId") ?? null,
    });
    const moved = await priceCategories.fileItems(await ctx(), input);
    return { message: moved.moved === 1 ? "Moved 1 item." : `Moved ${moved.moved} items.` };
  }));
}
