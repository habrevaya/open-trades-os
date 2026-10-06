import { priceBook, priceCategories, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import type { BookChoices } from "@/app/(app)/agreements/plans/PlanFields";

/**
 * The price book's categories and items, for choosing what a plan's discount
 * leaves out.
 *
 * Every category, and the first two hundred items still sold: a book bigger
 * than that is left out by category, which is how a company with a big book
 * thinks of it anyway. Nothing for somebody who may not read the price book;
 * the plan keeps whatever it already leaves out.
 */
export async function planBookChoices(ctx: ServiceContext): Promise<BookChoices> {
  if (!can(ctx.actor, "pricebook:read")) return { categories: [], items: [] };
  const [categories, items] = await Promise.all([
    priceCategories.list(ctx),
    priceBook.list(ctx, { limit: 200, includeInactive: false }),
  ]);
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, depth: c.depth })),
    items: items.data.map((i) => ({ id: i.id, name: i.name, code: i.code })),
  };
}
