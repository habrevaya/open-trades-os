import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, PageRequest, pageOf } from "./common";

/**
 * TAGS, AND DUPLICATES ACROSS THE WHOLE BOOK (M03)
 *
 * Tags were stored and read back and nothing could act on one: no list of the
 * tags in use, no filter, no way to fix two spellings of one tag. The customer
 * list now filters by tags (`GET /v1/customers` takes `tags` and `tagMatch`),
 * and these are the rest: the company's tags with counts, putting tags on and
 * off one customer, and renaming and merging across the book.
 *
 * The duplicate sweep is the per record matcher run over every pair at once,
 * with the same reasons, and a remembered "these are two people" so a pair
 * somebody already decided stops coming back.
 */

const Tag = z.string().min(1).max(40);

export const listCustomerTags = defineRoute({
  method: "get",
  path: "/v1/customer-tags",
  summary: "The tags in use, with how many customers carry each",
  description:
    "Compared without case, so \"vip\" and \"VIP\" are one row, shown in the spelling the book uses. Under the caller's scope, like the customer list.",
  module: "M03",
  permissions: ["customer:read"],
  input: z.object({}),
  output: z.object({
    tags: z.array(z.object({ tag: z.string(), customers: z.number().int() })),
  }),
});

export const setCustomerTags = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/tags",
  summary: "Put tags on a customer, or take them off",
  description:
    "A new tag takes the spelling the company already uses for it, so typing \"vip\" where the book says \"VIP\" adds \"VIP\". Idempotent by nature: adding a tag a customer has, or taking off one they do not, changes nothing.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    add: z.array(Tag).max(20).optional(),
    remove: z.array(Tag).max(20).optional(),
  }),
  output: z.object({ id: Uuid, tags: z.array(z.string()) }),
});

const Rewrite = z.object({
  tag: z.string(),
  /** How many customers were changed. */
  customers: z.number().int(),
});

export const renameCustomerTag = defineRoute({
  method: "post",
  path: "/v1/customer-tags/rename",
  summary: "Rename a tag on every customer that carries it",
  description:
    "Refused when the new name is already a different tag, because that is two segments becoming one, and the merge says so. Changing only the case of a tag is a rename. One statement across the book, and a replay with the same idempotency key returns the first answer rather than renaming nothing.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({ from: Tag, to: Tag }),
  output: Rewrite,
});

export const mergeCustomerTags = defineRoute({
  method: "post",
  path: "/v1/customer-tags/merge",
  summary: "Fold several tags into one",
  description:
    "Every customer carrying any of `from` carries `into` instead, once, where the first of them stood in their list. `into` may be new or already in use.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({ from: z.array(Tag).min(1).max(20), into: Tag }),
  output: Rewrite,
});

const Side = z.object({
  id: Uuid,
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});

export const listCustomerDuplicatePairs = defineRoute({
  method: "get",
  path: "/v1/customer-duplicates",
  summary: "Likely duplicates across every customer",
  description:
    "The per record matcher run over every pair at once: the same phone number, the same email address, or a name close enough by trigram that a person should look, strongest reason first. No score, for the reason the per record read gives. Pairs somebody marked as two people are left out. Needs `customer:merge`, because it reads across the whole book and exists to be acted on.",
  module: "M03",
  permissions: ["customer:merge"],
  input: PageRequest,
  output: pageOf(z.object({
    a: Side,
    b: Side,
    because: z.enum(["Same phone number", "Same email address", "Similar name"]),
  })),
});

export const dismissCustomerDuplicate = defineRoute({
  method: "post",
  path: "/v1/customer-duplicates/dismiss",
  summary: "Say two records are two people",
  description:
    "Remembered, so the pair stops appearing in the sweep and on either customer's own page. Stored once whichever way round it was said, and a second call changes nothing.",
  module: "M03",
  permissions: ["customer:merge"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    otherId: Uuid,
    reason: z.string().max(500).optional(),
  }),
  output: z.object({ customerAId: Uuid, customerBId: Uuid, dismissed: z.literal(true) }),
});

export const customerTagRoutes = {
  listCustomerTags, setCustomerTags, renameCustomerTag, mergeCustomerTags,
  listCustomerDuplicatePairs, dismissCustomerDuplicate,
} as const;
