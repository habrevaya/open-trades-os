import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * WHO MAY CHANGE A PRICE, AND WHO MAY GIVE ONE AWAY
 *
 * Three permissions were granted to roles and checked by nothing, and all
 * three are about the same thing from two directions: what a company's prices
 * are, and how much of one somebody may hand back.
 *
 *   `pricebook:publish`              the excuse said M06 has no draft state
 *                                    to publish from. It had one and could
 *                                    not see it: `revise` has always taken an
 *                                    `effectiveFrom`, and a date ahead is a
 *                                    staged revision. What was missing was any
 *                                    way to see one, bring it forward or call
 *                                    it off, and a bug that made the idea
 *                                    unusable.
 *
 *   `estimate:discount`              `estimate_line.discount_amount` has
 *   `estimate.discount.unlimited`    existed since the first migration and
 *                                    anybody with `estimate:write` could set
 *                                    it to anything. A technician standing in
 *                                    a kitchen could take a forty thousand
 *                                    dollar re-pipe to zero.
 */

/* ------------------------------------------------ revisions dated ahead */

export const ScheduledRevision = z.object({
  versionId: Uuid,
  itemId: Uuid,
  code: z.string(),
  name: z.string(),
  version: z.number(),
  /** What it will become. */
  price: MoneyString,
  /** What it is until then. Null when the item has no version in force. */
  currentPrice: MoneyString.nullable(),
  effectiveFrom: z.string(),
});

export const listScheduledRevisions = defineRoute({
  method: "get",
  path: "/v1/pricebook/scheduled",
  summary: "Price changes that have not taken effect yet",
  description:
    "pricebook:read rather than pricebook:publish, because knowing a price change is coming is part of reading the price book: a technician quoting work for next month needs to know, and putting it behind the publish permission would hide it from the people most affected.",
  module: "M06",
  permissions: ["pricebook:read"],
  input: z.object({}),
  output: z.object({ revisions: z.array(ScheduledRevision) }),
});

export const publishRevision = defineRoute({
  method: "post",
  path: "/v1/pricebook/scheduled/{versionId}/publish",
  summary: "Bring a scheduled price change forward to now",
  description:
    "Two writes that have to agree: the predecessor closes at this instant and the revision opens at it. One without the other is the gap or the overlap the versioning model exists to prevent.",
  module: "M06",
  permissions: ["pricebook:publish"],
  idempotent: true,
  input: z.object({ versionId: Uuid }),
  output: z.object({ versionId: Uuid, effectiveFrom: z.string() }),
});

export const discardRevision = defineRoute({
  method: "post",
  path: "/v1/pricebook/scheduled/{versionId}/discard",
  summary: "Call a scheduled price change off",
  description:
    "Reopens the version it was going to replace, which is the half that matters: without it the old version stays closed at a date in the future and, once that date passes, the item has no price in force at all. Soft deleted rather than removed, because somebody may already have quoted against the schedule.",
  module: "M06",
  permissions: ["pricebook:publish"],
  idempotent: true,
  input: z.object({ versionId: Uuid }),
  output: z.object({ versionId: Uuid, discarded: z.boolean() }),
});

/* ------------------------------------------------------- discount limits */

export const DiscountPolicy = z.object({
  /**
   * A FRACTION, not a count of percentage points. 0.1 is ten per cent, as
   * every other rate in this product is. A value above one is refused rather
   * than divided by a hundred on the caller's behalf, because guessing which
   * of the two they meant is how a limit ends up a hundred times too small.
   */
  maxPercent: RateString,
  /** An absolute ceiling as well. Both apply and the lower wins. */
  maxAmount: MoneyString.nullable(),
  note: z.string().nullable(),
});

export const getDiscountPolicy = defineRoute({
  method: "get",
  /**
   * NOT `/v1/estimates/discount-policy`, which was the first spelling and is
   * ambiguous against `GET /v1/estimates/{id}`. An ambiguous route does not
   * fail: it quietly serves the wrong handler, and a guard test is the only
   * reason this was noticed rather than shipped.
   */
  path: "/v1/estimate-discount-policy",
  summary: "The most anybody may take off an estimate",
  description:
    "Null means the company has not set one, which authorises nobody to discount. That is deliberate and it is the opposite of the usual default: treating silence as unlimited would give every company that never opened this screen a technician who can discount a job to nothing.",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({}),
  output: z.object({ policy: DiscountPolicy.nullable() }),
});

export const setDiscountPolicy = defineRoute({
  method: "put",
  path: "/v1/estimates/discount-policy",
  summary: "Set the discount limit",
  description:
    "settings:write, not estimate:discount. Holding the authority to apply a discount is not the authority to decide how large a discount anybody may apply, and one permission for both means everybody who can discount can raise their own ceiling.",
  module: "M07",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    maxPercent: RateString,
    maxAmount: MoneyString.nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  }),
  output: DiscountPolicy,
});

export const clearDiscountPolicy = defineRoute({
  method: "post",
  path: "/v1/estimate-discount-policy/clear",
  summary: "Take the discount limit away",
  description:
    "Puts the company back to nobody being authorised to discount. Soft deleted rather than removed, so the previous limit stays readable as the record of what was authorised when an older estimate was written.",
  module: "M07",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({}),
  output: z.object({ cleared: z.boolean() }),
});

export const pricingAuthorityRoutes = {
  listScheduledRevisions,
  publishRevision,
  discardRevision,
  getDiscountPolicy,
  setDiscountPolicy,
  clearDiscountPolicy,
} as const;
