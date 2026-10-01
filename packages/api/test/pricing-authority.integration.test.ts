import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { estimate as est, money as m } from "@opentradesos/core";
import * as priceBook from "../src/services/pricebook";
import * as estimates from "../src/services/estimates";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHO MAY CHANGE A PRICE, AND WHO MAY GIVE ONE AWAY
 *
 * Three permissions were granted to roles and checked by nothing, and finding
 * out why turned up a shipped bug that nothing in the suite could see.
 *
 * `revise` has always accepted an `effectiveFrom`, and every reader of the
 * price book asked "which price applies" as `effective_to IS NULL`. That is
 * the OPEN ENDED row, not the current one. A revision dated next month closes
 * the old row at next month and opens the new one there, so the new row is
 * the one with a null `effective_to`:
 *
 *   the future price applied from the moment it was entered, and
 *   the price actually in force became invisible everywhere.
 *
 * Four services had the same line. The first block below is about that, and
 * it is the reason the rest of the module could exist at all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pa:org");
const USER = fixtureId("pa:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/**
 * AN OFFICE MANAGER, who holds `estimate:discount` and NOT
 * `estimate.discount.unlimited`.
 *
 * The capped actor, and a real role rather than a synthetic grant set, which
 * is worth more here: it asserts that the role presets are sensible as well
 * as that the check works. `owner` and `admin` both hold the unlimited
 * permission, which is correct and makes them useless for testing a cap. The
 * first version of these tests used `owner` and every refusal resolved.
 */
const manager = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] },
  db: db(),
});

/** Exactly these permissions and no role, which is the only actor that can tell a pair apart. */
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let customerId = "";
let propertyId = "";
let categoryId = "";

const MONTH_AHEAD = () => new Date(Date.now() + 30 * 86_400_000);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pricing Co", slug: "pricing-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'residential', 'Priced Ltd') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '3 Price Place', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
  const [category] = await raw<{ id: string }[]>`
    insert into public.price_book_category (organization_id, name)
    values (${ORG}, 'Services') returning id`;
  categoryId = category!.id;
});

async function item(code: string, price: string): Promise<string> {
  const made = await priceBook.create(owner(), {
    categoryId, kind: "service", code, name: `Item ${code}`,
    price, taxable: true,
  } as never);
  return made.id;
}

/* ------------------------------------------- which price actually applies */

run("the price in force", () => {
  it("keeps today's price when a revision is dated ahead", async () => {
    /**
     * THE SHIPPED BUG. Every reader asked `effective_to IS NULL`, which after
     * a future dated revise is the FUTURE row. So the increase applied from
     * the moment it was typed.
     */
    const id = await item("SVC-1", "100.0000");
    await priceBook.revise(owner(), {
      id, price: "150.0000", effectiveFrom: MONTH_AHEAD().toISOString(),
    } as never);

    const listed = await priceBook.list(owner(), { limit: 50 } as never);
    const found = listed.data.find((row) => row.id === id)!;
    expect(found.price).toBe("100.0000");
  });

  it("applies it once the date arrives, with no gap in between", async () => {
    /**
     * The other half, and the one that proves the window is half open rather
     * than simply shifted: at the instant the revision starts, exactly one
     * version is in force, and it is the new one.
     */
    const id = await item("SVC-2", "100.0000");
    const at = MONTH_AHEAD();
    await priceBook.revise(owner(), {
      id, price: "150.0000", effectiveFrom: at.toISOString(),
    } as never);

    const rows = await raw<{ price: string }[]>`
      select price from public.price_book_item_version
      where item_id = ${id}
        and effective_from <= ${at}
        and (effective_to is null or effective_to > ${at})`;
    expect(rows.map((r) => r.price)).toEqual(["150.0000"]);

    // And one second before it, still the old one. No gap, no overlap.
    const before = new Date(at.getTime() - 1000);
    const earlier = await raw<{ price: string }[]>`
      select price from public.price_book_item_version
      where item_id = ${id}
        and effective_from <= ${before}
        and (effective_to is null or effective_to > ${before})`;
    expect(earlier.map((r) => r.price)).toEqual(["100.0000"]);
  });

  it("takes effect immediately when no date is given", async () => {
    const id = await item("SVC-3", "100.0000");
    await priceBook.revise(owner(), { id, price: "120.0000" } as never);
    const listed = await priceBook.list(owner(), { limit: 50 } as never);
    expect(listed.data.find((row) => row.id === id)!.price).toBe("120.0000");
  });
});

/* ------------------------------------------------ revisions dated ahead */

run("price changes that have not happened yet", () => {
  it("lists what is coming, beside what the price is now", async () => {
    /**
     * A scheduled revision on its own does not answer the question anybody
     * opens this screen for, which is by how much it is going up.
     */
    const id = await item("SVC-4", "100.0000");
    await priceBook.revise(owner(), {
      id, price: "150.0000", effectiveFrom: MONTH_AHEAD().toISOString(),
    } as never);

    const scheduled = await priceBook.scheduledRevisions(owner());
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      itemId: id, code: "SVC-4", price: "150.0000", currentPrice: "100.0000",
    });
  });

  it("lists nothing when every revision is already in force", async () => {
    const id = await item("SVC-5", "100.0000");
    await priceBook.revise(owner(), { id, price: "120.0000" } as never);
    expect(await priceBook.scheduledRevisions(owner())).toEqual([]);
  });

  it("brings one forward, and the predecessor closes at the same instant", async () => {
    /**
     * Two writes that have to agree. One without the other is the gap or the
     * overlap the versioning model exists to prevent, and here it would be in
     * the middle of a chain rather than at the end.
     */
    const id = await item("SVC-6", "100.0000");
    await priceBook.revise(owner(), {
      id, price: "150.0000", effectiveFrom: MONTH_AHEAD().toISOString(),
    } as never);
    const [scheduled] = await priceBook.scheduledRevisions(owner());

    await priceBook.publishRevision(owner(), { versionId: scheduled!.versionId });

    const listed = await priceBook.list(owner(), { limit: 50 } as never);
    expect(listed.data.find((row) => row.id === id)!.price).toBe("150.0000");
    expect(await priceBook.scheduledRevisions(owner())).toEqual([]);

    // Exactly one version in force, which is what the two writes together buy.
    const live = await raw<{ price: string }[]>`
      select price from public.price_book_item_version
      where item_id = ${id}
        and effective_from <= now()
        and (effective_to is null or effective_to > now())`;
    expect(live.map((r) => r.price)).toEqual(["150.0000"]);
  });

  it("refuses to publish something already in force", async () => {
    const id = await item("SVC-7", "100.0000");
    const current = await raw<{ id: string }[]>`
      select id from public.price_book_item_version where item_id = ${id}`;
    await expect(priceBook.publishRevision(owner(), { versionId: current[0]!.id }))
      .rejects.toThrow(/already in force/);
  });

  it("calls one off, and reopens the version it was going to replace", async () => {
    /**
     * REOPENING IS THE HALF THAT MATTERS. Without it the old version stays
     * closed at a date in the future and, once that date passes, the item has
     * no version in force at all: it vanishes from the price book and an
     * estimate referencing it finds no price. Cancelling a revision is the
     * one operation that can open that gap.
     */
    const id = await item("SVC-8", "100.0000");
    const at = MONTH_AHEAD();
    await priceBook.revise(owner(), {
      id, price: "150.0000", effectiveFrom: at.toISOString(),
    } as never);
    const [scheduled] = await priceBook.scheduledRevisions(owner());

    await priceBook.discardRevision(owner(), { versionId: scheduled!.versionId });

    expect(await priceBook.scheduledRevisions(owner())).toEqual([]);
    const listed = await priceBook.list(owner(), { limit: 50 } as never);
    expect(listed.data.find((row) => row.id === id)!.price).toBe("100.0000");

    /**
     * And AFTER the date the cancelled revision would have started, the old
     * price is still in force. This is the assertion the reopen exists for:
     * without it, this query returns nothing.
     */
    const after = new Date(at.getTime() + 86_400_000);
    const live = await raw<{ price: string }[]>`
      select price from public.price_book_item_version
      where item_id = ${id}
        and deleted_at is null
        and effective_from <= ${after}
        and (effective_to is null or effective_to > ${after})`;
    expect(live.map((r) => r.price)).toEqual(["100.0000"]);
  });

  it("refuses to call off something already in force", async () => {
    const id = await item("SVC-9", "100.0000");
    const current = await raw<{ id: string }[]>`
      select id from public.price_book_item_version where item_id = ${id}`;
    await expect(priceBook.discardRevision(owner(), { versionId: current[0]!.id }))
      .rejects.toThrow(/already in force/);
  });

  it("refuses to call off an item's only version", async () => {
    /**
     * A scheduled revision with no predecessor is the item's first version
     * dated ahead, and discarding it leaves an item with no price at any
     * instant. That is a different operation: retire the item.
     */
    const id = await item("SVC-10", "100.0000");
    const at = MONTH_AHEAD();
    await raw`update public.price_book_item_version
              set effective_from = ${at} where item_id = ${id}`;
    const [scheduled] = await priceBook.scheduledRevisions(owner());
    await expect(priceBook.discardRevision(owner(), { versionId: scheduled!.versionId }))
      .rejects.toThrow(/only version this item has/);
  });

  it("lets somebody read the schedule without being able to change it", async () => {
    /**
     * The authority split this whole surface exists to create:
     * `pricebook:write` drafts next quarter's prices and `pricebook:publish`
     * decides what the price is today. A reader can see what is coming,
     * because a technician quoting next month's work needs to.
     */
    const id = await item("SVC-11", "100.0000");
    await priceBook.revise(owner(), {
      id, price: "150.0000", effectiveFrom: MONTH_AHEAD().toISOString(),
    } as never);
    const [scheduled] = await priceBook.scheduledRevisions(owner());

    await expect(priceBook.scheduledRevisions(granted("pricebook:read")))
      .resolves.toHaveLength(1);
    await expect(priceBook.publishRevision(
      granted("pricebook:read", "pricebook:write"), { versionId: scheduled!.versionId },
    )).rejects.toThrow();
    await expect(priceBook.discardRevision(
      granted("pricebook:read", "pricebook:write"), { versionId: scheduled!.versionId },
    )).rejects.toThrow();
    await expect(priceBook.publishRevision(
      granted("pricebook:publish"), { versionId: scheduled!.versionId },
    )).resolves.toMatchObject({ versionId: scheduled!.versionId });
  });

  it("does not find another company's version", async () => {
    /**
     * ROW LEVEL SECURITY IS WHAT MAKES THIS TRUE, not the organization clause
     * in the query, which a deliberate breakage proved: removing it left this
     * green because the row is invisible to the other tenant's session
     * anyway. The clause stays because every write in this product carries
     * one and an inconsistent pattern is how the one that matters gets left
     * off, but this test is about the database guarantee.
     */
    const id = await item("SVC-12", "100.0000");
    await priceBook.revise(owner(), {
      id, price: "150.0000", effectiveFrom: MONTH_AHEAD().toISOString(),
    } as never);
    const [scheduled] = await priceBook.scheduledRevisions(owner());
    const other: ServiceContext = {
      actor: {
        userId: USER, organizationId: fixtureId("pa:other"), roles: ["owner"] as Actor["roles"],
      },
      db: db(),
    };
    await expect(other && priceBook.publishRevision(other, { versionId: scheduled!.versionId }))
      .rejects.toThrow(NotFoundError);
  });
});

/* -------------------------------------------------- the discount decision */

describe("the discount decision, in core", () => {
  const usd = (v: string) => m.money(v, "USD");
  const base = {
    subtotal: usd("1000.0000"),
    mayDiscount: true,
    uncapped: false,
    policy: { maxPercent: "0.1" },
  };

  it("always allows a discount of nothing", () => {
    /**
     * Before any authority question. A line with no discount is an ordinary
     * line, and requiring the permission for one would mean a technician who
     * may quote cannot quote at all.
     */
    expect(est.checkDiscount({
      ...base, discount: usd("0"), mayDiscount: false, policy: null,
    })).toEqual({ allowed: true });
  });

  it("refuses a negative discount before asking about authority", () => {
    /**
     * It is a surcharge wearing a discount's name: it would pass any cap by
     * being comfortably under it, and the total it produces is higher than
     * the price the customer was shown. No permission should authorise that
     * by accident, which is why the order of these checks matters.
     */
    const verdict = est.checkDiscount({
      ...base, discount: usd("-50.0000"), uncapped: true,
    });
    expect(verdict).toMatchObject({ allowed: false, reason: "negative" });
  });

  it("refuses a discount larger than the work, even uncapped", () => {
    /**
     * An option that costs less than nothing is not a steep discount, it is a
     * company paying somebody to take the work.
     */
    const verdict = est.checkDiscount({
      ...base, discount: usd("1500.0000"), uncapped: true,
    });
    expect(verdict).toMatchObject({ allowed: false, reason: "exceeds_subtotal" });
  });

  it("refuses somebody with no discount authority at all", () => {
    expect(est.checkDiscount({ ...base, discount: usd("10.0000"), mayDiscount: false }))
      .toMatchObject({ allowed: false, reason: "no_authority" });
  });

  it("refuses everybody when the company has set no limit", () => {
    /**
     * The opposite of the usual default, deliberately. A company that has not
     * said what its limit is has not authorised anybody to give money away,
     * and treating silence as unlimited means every company that never opened
     * the settings page has a technician who can discount a job to nothing.
     */
    expect(est.checkDiscount({ ...base, discount: usd("10.0000"), policy: null }))
      .toMatchObject({ allowed: false, reason: "no_policy" });
  });

  it("lets the uncapped through even with no limit set", () => {
    /**
     * The permission's whole meaning is "not subject to the limit", and a
     * limit that does not exist is the easiest kind not to be subject to.
     */
    expect(est.checkDiscount({
      ...base, discount: usd("900.0000"), policy: null, uncapped: true, mayDiscount: false,
    })).toEqual({ allowed: true });
  });

  it("allows up to the percentage and refuses a penny over", () => {
    expect(est.checkDiscount({ ...base, discount: usd("100.0000") })).toEqual({ allowed: true });
    const over = est.checkDiscount({ ...base, discount: usd("100.0100") });
    expect(over).toMatchObject({ allowed: false, reason: "over_cap" });
    if (over.allowed) return;
    expect(m.toString(over.ceiling!)).toBe("100.0000");
  });

  it("applies both ceilings and lets the LOWER win", () => {
    /**
     * "Up to ten per cent, and never more than fifty" is a sentence an owner
     * says out loud. The other reading, whichever is larger, would make the
     * second half authorise more than the first, which is the opposite of
     * what somebody writing a second limit intends.
     */
    const policy = { maxPercent: "0.1", maxAmount: usd("50.0000") };
    expect(est.checkDiscount({ ...base, discount: usd("50.0000"), policy }))
      .toEqual({ allowed: true });
    const over = est.checkDiscount({ ...base, discount: usd("60.0000"), policy });
    expect(over).toMatchObject({ allowed: false, reason: "over_cap" });
    if (over.allowed) return;
    expect(m.toString(over.ceiling!)).toBe("50.0000");

    /**
     * And the other way round: an amount ceiling ABOVE the percentage must
     * not raise it. This is the assertion that tells "lower wins" from
     * "whichever was written second".
     */
    const generous = { maxPercent: "0.1", maxAmount: usd("500.0000") };
    expect(est.checkDiscount({ ...base, discount: usd("200.0000"), policy: generous }))
      .toMatchObject({ allowed: false, reason: "over_cap" });
  });

  it("has a sentence for every refusal", () => {
    /**
     * Derived from the union rather than listed, so a new reason cannot be
     * added without a sentence: the default arm is a `never` assignment and
     * would not compile.
     */
    const reasons: Record<Extract<est.DiscountVerdict, { allowed: false }>["reason"], true> = {
      no_authority: true, no_policy: true, over_cap: true,
      negative: true, exceeds_subtotal: true,
    };
    for (const reason of Object.keys(reasons) as (keyof typeof reasons)[]) {
      const sentence = est.discountRefusal({ allowed: false, reason, ceiling: usd("10.0000") });
      expect(sentence.length, reason).toBeGreaterThan(30);
      expect(sentence, reason).not.toContain("undefined");
    }
  });
});

/* ------------------------------------------- the discount limit, in the service */

run("the discount limit", () => {
  const line = (unitPrice: string, discountAmount: string) => ({
    name: "Work", quantity: "1", unitPrice, discountAmount,
    taxable: false, isOptional: false, isSelected: true,
  });
  const quote = (discountAmount: string) => ({
    customerId, propertyId, taxRate: "0",
    options: [{
      name: "Only option", isRecommended: true,
      lines: [line("1000.0000", discountAmount)],
    }],
  });

  it("refuses a discount when the company has set no limit", async () => {
    await expect(estimates.create(manager(), quote("100.0000") as never))
      .rejects.toThrow(/has not set a discount limit/);
  });

  it("allows a quote with no discount with no limit set", async () => {
    await expect(estimates.create(manager(), quote("0") as never)).resolves.toBeTruthy();
  });

  it("allows a discount inside the limit and refuses one over it", async () => {
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.1" });
    await expect(estimates.create(manager(), quote("100.0000") as never)).resolves.toBeTruthy();
    await expect(estimates.create(manager(), quote("200.0000") as never))
      .rejects.toThrow(/more than the limit/);
    /**
     * And an owner, who holds the unlimited permission, is NOT stopped by the
     * same limit. Asserted here so this test says which actor the cap is
     * about rather than only that a cap exists.
     */
    await expect(estimates.create(owner(), quote("200.0000") as never)).resolves.toBeTruthy();
  });

  it("judges the discount against the option, not against each line", async () => {
    /**
     * THE UNIT THE CAP IS ABOUT, and the first version of this test claimed
     * the wrong reason for it: "ten per cent off each of eight lines is
     * eighty per cent off the option". It is not. If every line is discounted
     * ten per cent then the option is discounted ten per cent, so the two
     * readings agree on a proportional discount and the test proved nothing.
     *
     * Where they genuinely differ is a CONCENTRATED discount. One line given
     * away entirely, inside a big option, is a hundred per cent of that line
     * and nine per cent of what the customer is choosing. The option is the
     * unit a customer picks and the unit a company means when it says ten per
     * cent, so this is allowed.
     *
     * And the second half is what stops that being a loophole: the same
     * concentrated discount in a SMALL option is over the limit, because the
     * limit is about the option either way.
     */
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.1" });

    await expect(estimates.create(manager(), {
      customerId, propertyId, taxRate: "0",
      options: [{
        name: "One line given away inside a big option", isRecommended: true,
        lines: [line("1000.0000", "0"), line("100.0000", "100.0000")],
      }],
    } as never)).resolves.toBeTruthy();

    await expect(estimates.create(manager(), {
      customerId, propertyId, taxRate: "0",
      options: [{
        name: "The same line given away on its own", isRecommended: true,
        lines: [line("100.0000", "100.0000")],
      }],
    } as never)).rejects.toThrow(/more than the limit/);
  });

  it("refuses a limit written as a percentage point count", async () => {
    /**
     * Every rate in this product is a fraction: 0.1 is ten per cent. Somebody
     * typing 10 means ten per cent and would be authorising a thousand.
     * Refused rather than divided by a hundred on their behalf, because
     * guessing is how a limit ends up a hundred times too small instead.
     */
    await expect(estimates.setDiscountPolicy(owner(), { maxPercent: "10" }))
      .rejects.toThrow(/fraction rather than a percentage/);
    await expect(estimates.setDiscountPolicy(owner(), { maxPercent: "-0.1" }))
      .rejects.toThrow(/cannot be negative/);
  });

  it("replaces the limit rather than adding a second", async () => {
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.1" });
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.2", note: "Spring promotion" });
    const policy = await estimates.discountPolicy(owner());
    expect(policy).toMatchObject({ maxPercent: "0.200000", note: "Spring promotion" });
    await expect(estimates.create(owner(), quote("200.0000") as never)).resolves.toBeTruthy();
  });

  it("takes the limit away, and nobody may discount again", async () => {
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.1" });
    await estimates.clearDiscountPolicy(owner());
    expect(await estimates.discountPolicy(owner())).toBeNull();
    await expect(estimates.create(manager(), quote("50.0000") as never))
      .rejects.toThrow(/has not set a discount limit/);
    // And it can be set again afterwards, which the partial index allows.
    await expect(estimates.setDiscountPolicy(owner(), { maxPercent: "0.05" }))
      .resolves.toMatchObject({ maxPercent: "0.050000" });
  });

  it("refuses clearing a limit that is not there", async () => {
    await expect(estimates.clearDiscountPolicy(owner())).rejects.toThrow(NotFoundError);
  });

  it("lets somebody who may discount do so, and not raise their own ceiling", async () => {
    /**
     * Holding the authority to apply a discount is not the authority to decide
     * how large a discount anybody may apply. One permission for both means
     * everybody who can discount can raise their own limit, which is the same
     * as having none.
     */
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.1" });
    const seller = granted(
      "estimate:read", "estimate:write", "estimate:discount",
      "customer:read", "property:read", "pricebook:read",
    );
    await expect(estimates.create(seller, quote("100.0000") as never)).resolves.toBeTruthy();
    await expect(estimates.setDiscountPolicy(seller, { maxPercent: "0.9" })).rejects.toThrow();
  });

  it("refuses somebody with no discount authority, limit or no limit", async () => {
    /**
     * THE SERVICE SIDE OF `no_authority`, which was only tested in core.
     *
     * A deliberate breakage found the gap: forcing `mayDiscount` to true in
     * the service left everything green, because every actor in these tests
     * held the permission. The one who does not is the one this check exists
     * for, and a technician is exactly that person: they may write an
     * estimate and may not discount one.
     */
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.5" });
    const tech = granted(
      "estimate:read", "estimate:write", "customer:read", "property:read", "pricebook:read",
    );
    await expect(estimates.create(tech, quote("100.0000") as never))
      .rejects.toThrow(/do not have permission to discount/);
    // And they can still quote, which is the whole reason the permission is
    // separate from `estimate:write`.
    await expect(estimates.create(tech, quote("0") as never)).resolves.toBeTruthy();
  });

  it("applies an absolute ceiling as well as the percentage", async () => {
    /**
     * THE SERVICE SIDE OF THE SECOND CEILING, also only tested in core. A
     * deliberate breakage dropped `maxAmount` on the way from the row into
     * the decision and every test stayed green, because no service test set
     * one.
     *
     * Ten per cent of a thousand is a hundred, and the company has also said
     * never more than fifty. The lower wins.
     */
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.1", maxAmount: "50.0000" });
    await expect(estimates.create(manager(), quote("50.0000") as never)).resolves.toBeTruthy();
    await expect(estimates.create(manager(), quote("75.0000") as never))
      .rejects.toThrow(/more than the limit/);
  });

  it("lets the uncapped exceed the limit, and stops everybody else", async () => {
    await estimates.setDiscountPolicy(owner(), { maxPercent: "0.1" });
    const common = ["estimate:read", "estimate:write", "customer:read", "property:read", "pricebook:read"];

    await expect(estimates.create(
      granted(...common, "estimate:discount"), quote("500.0000") as never,
    )).rejects.toThrow(/more than the limit/);

    await expect(estimates.create(
      granted(...common, "estimate.discount.unlimited"), quote("500.0000") as never,
    )).resolves.toBeTruthy();
  });
});
