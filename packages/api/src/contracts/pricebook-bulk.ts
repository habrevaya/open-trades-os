import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * THE PRICE BOOK'S SHELVES, AND CHANGING MANY PRICES AT ONCE (M06)
 *
 * Categories were a column and a seed with no way to reorganise them, and a
 * seeded book could only be re-priced one item at a time, so it stayed at
 * national averages. These are the category manager and the bulk change.
 *
 * A bulk change is written as a NEW VERSION per item, the way a single
 * revision is, and recorded as one change with each item's price before and
 * after, so it can be undone as another change.
 */

const Category = z.object({
  id: Uuid,
  name: z.string(),
  code: z.string().nullable(),
  parentId: Uuid.nullable(),
  sortOrder: z.number().int(),
  /** 0 for the top level. A client indents off this. */
  depth: z.number().int(),
  /** Items filed directly here that are still sold. */
  items: z.number().int(),
});

export const listPriceBookCategories = defineRoute({
  method: "get",
  path: "/v1/pricebook/categories",
  summary: "The price book's categories, in reading order",
  description:
    "FLAT, with a depth on every row, each category followed by the ones inside it. A recursive schema cannot be published, and a flat list in reading order is what a client renders anyway.",
  module: "M06",
  permissions: ["pricebook:read"],
  input: z.object({}),
  output: z.object({ categories: z.array(Category) }),
});

export const createPriceBookCategory = defineRoute({
  method: "post",
  path: "/v1/pricebook/categories",
  summary: "Add a category",
  description:
    "Three levels deep at most. A name already used under the same parent is refused, compared without case.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(80),
    parentId: Uuid.nullable().optional(),
    code: z.string().max(40).optional(),
  }),
  output: Category,
});

export const updatePriceBookCategory = defineRoute({
  method: "patch",
  path: "/v1/pricebook/categories/{id}",
  summary: "Rename a category, or move it under another",
  description:
    "`parentId: null` moves it to the top. A move that would put a category inside itself is refused. Moving goes to the end of the new siblings.",
  module: "M06",
  permissions: ["pricebook:write"],
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(80).optional(),
    code: z.string().max(40).nullable().optional(),
    parentId: Uuid.nullable().optional(),
  }),
  output: z.object({ id: Uuid }),
});

export const placePriceBookCategory = defineRoute({
  method: "post",
  path: "/v1/pricebook/categories/{id}/place",
  summary: "Put a category at a position among its siblings",
  description:
    "A position, counting from nought, rather than \"up one\", so a retried call lands where the first one did.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({ id: Uuid, position: z.number().int().min(0).max(1000) }),
  output: z.object({ id: Uuid, position: z.number().int() }),
});

export const removePriceBookCategory = defineRoute({
  method: "post",
  path: "/v1/pricebook/categories/{id}/remove",
  summary: "Remove an empty category",
  description:
    "Refused while it holds items or other categories, with how many, because removing it would leave them filed nowhere.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const filePriceBookItems = defineRoute({
  method: "post",
  path: "/v1/pricebook/item-categories",
  summary: "Move items into a category, or out of every one",
  description:
    "Changed on the item rather than as a new version, because the category is on no document: an invoice points at a version, and moving an item between shelves changes nothing anybody was charged.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    itemIds: z.array(Uuid).min(1).max(500),
    categoryId: Uuid.nullable(),
  }),
  output: z.object({ moved: z.number().int() }),
});

/**
 * The selection and the rule, flat, which is what a query string and a form
 * both carry. `mode` chooses what `value` means.
 */
const ChangeInput = z.object({
  categoryId: Uuid.optional(),
  includeSubcategories: z.boolean().optional(),
  q: z.string().max(200).optional(),
  itemIds: z.array(Uuid).max(2000).optional(),
  /**
   * `percent`: `value` is a percentage, 5 or -10. `amount`: an amount, 12.50
   * or -5. `margin`: the margin over cost as a fraction, 0.45. `round`: no
   * change, only the ending.
   */
  mode: z.enum(["percent", "amount", "margin", "round"]),
  value: z.string().max(20).optional(),
  /** Round up to the next price ending in these cents: 00, 95, 99. */
  ending: z.string().regex(/^\d{2}$/).optional(),
});

const PreviewLine = z.object({
  itemId: Uuid,
  code: z.string(),
  name: z.string(),
  categoryId: Uuid.nullable(),
  priceBefore: MoneyString,
  priceAfter: MoneyString.nullable(),
  /** Present only for a caller holding pricebook.cost:read. */
  cost: MoneyString.nullable().optional(),
  marginBefore: RateString.nullable().optional(),
  marginAfter: RateString.nullable().optional(),
  skipped: z.string().nullable(),
});

export const previewPriceChange = defineRoute({
  method: "get",
  path: "/v1/pricebook/price-change-preview",
  summary: "Every price a change would set, before it is applied",
  description:
    "Each selected item with its price before and after and, for whoever may see cost, its margin before and after. An item that would not change says why: no cost recorded for a margin rule, a change that would price it at nothing, or a revision already scheduled. A margin rule needs `pricebook.cost:read`.",
  module: "M06",
  permissions: ["pricebook:write"],
  input: ChangeInput,
  output: z.object({
    description: z.string(),
    changing: z.number().int(),
    lines: z.array(PreviewLine),
  }),
});

const Applied = z.object({
  id: Uuid,
  description: z.string(),
  changed: z.number().int(),
  skipped: z.array(z.object({ itemId: Uuid, code: z.string(), reason: z.string() })),
});

export const applyPriceChange = defineRoute({
  method: "post",
  path: "/v1/pricebook/price-changes",
  summary: "Apply a change to many prices",
  description:
    "Recomputed inside the write rather than taken from a preview that may be a minute old, and written as a new version per item, the way a single revision is: no version is edited in place, so every document already raised keeps its price. `itemIds` narrows the selection to the items left ticked. Takes effect now.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: ChangeInput,
  output: Applied,
});

const Change = z.object({
  id: Uuid,
  kind: z.enum(["change", "reversal"]),
  description: z.string(),
  itemCount: z.number().int(),
  appliedBy: z.string().nullable(),
  appliedAt: z.string(),
  reversesId: Uuid.nullable(),
  reversedById: Uuid.nullable(),
});

export const listPriceChanges = defineRoute({
  method: "get",
  path: "/v1/pricebook/price-changes",
  summary: "The bulk changes made to the price book, newest first",
  module: "M06",
  permissions: ["pricebook:read"],
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ changes: z.array(Change) }),
});

export const getPriceChange = defineRoute({
  method: "get",
  path: "/v1/pricebook/price-changes/{id}",
  summary: "One bulk change, item by item",
  module: "M06",
  permissions: ["pricebook:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    kind: z.enum(["change", "reversal"]),
    description: z.string(),
    appliedAt: z.string(),
    reversesId: Uuid.nullable(),
    reversedById: Uuid.nullable(),
    /** For an undo: the items it left alone because they had changed again since. */
    skipped: z.array(z.object({ itemId: Uuid, code: z.string(), reason: z.string() })),
    lines: z.array(z.object({
      itemId: Uuid, code: z.string(), name: z.string(), priceBefore: MoneyString, priceAfter: MoneyString,
    })),
  }),
});

export const reversePriceChange = defineRoute({
  method: "post",
  path: "/v1/pricebook/price-changes/{id}/reverse",
  summary: "Undo a bulk change",
  description:
    "Each item goes back to the price it had, as another new version, and the undo is recorded as a change of its own pointing at this one. Not the opposite percentage: five per cent up and five per cent down is 99.75, not 100. An item changed again since is left alone and named.",
  module: "M06",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Applied,
});

export const priceBookBulkRoutes = {
  listPriceBookCategories, createPriceBookCategory, updatePriceBookCategory, placePriceBookCategory,
  removePriceBookCategory, filePriceBookItems,
  previewPriceChange, applyPriceChange, listPriceChanges, getPriceChange, reversePriceChange,
} as const;
