import { describe, it, expect } from "vitest";
import { priceOnSite, memberEligible, sameAmount, rateFromPercent, tipChoices, addAmounts, type OnSiteLine, type OnSiteMember } from "../src/field/pricing.js";
import { tipChoices as portalTipChoices } from "../src/customer-portal/index.js";
import { computeOption } from "../src/estimate/index.js";
import { computeInvoice } from "../src/ledger/index.js";
import { memberDiscounts, eligibleForMemberPricing } from "../src/membership/index.js";
import { money, toString, add, zero, type Money } from "../src/money/index.js";

/**
 * THE PHONE'S SUM, HELD TO THE SERVER'S
 *
 * A customer signs on the phone for the figure the phone worked out, and the
 * server writes the figure core works out. The two are separate code on
 * purpose (the phone bundles one file with no imports), so they are held
 * together here over thousands of random documents: every line's discount,
 * tax and total, and the document's four totals, to the cent.
 */

/** A small deterministic generator, so a failure names a seed that reproduces it. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  return { next, int, pick };
}

const dollars = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

function randomLine(g: ReturnType<typeof generator>): OnSiteLine {
  const quantity = g.pick(["1", "2", "3", "0.5", "1.25", "12", "2.333"]);
  const price = g.pick([
    dollars(g.int(0, 250_000)),
    `${g.int(0, 400)}.${String(g.int(0, 9999)).padStart(4, "0")}`,
    "0", "89", "4210.00", "0.1875",
  ]);
  return {
    quantity,
    unitPrice: price,
    discountAmount: g.next() < 0.2 ? dollars(g.int(0, 2_000)) : "0",
    taxable: g.next() < 0.7,
    taxRate: g.pick(["0", "0.0825", "0.07", "0.06875", "0.1"]),
    isOptional: g.next() < 0.3,
    isSelected: g.next() < 0.5,
    itemKind: g.pick([null, "service", "material", "fee", "discount", "labor"]),
    feeRole: g.pick([null, null, null, "diagnostic", "after_hours"]),
  };
}

function randomMember(g: ReturnType<typeof generator>): OnSiteMember | null {
  if (g.next() < 0.35) return null;
  return {
    rate: g.pick(["0", "0.1", "0.15", "0.125", "0.2", "0.333333"]),
    waivesDiagnosticFee: g.next() < 0.5,
    waivesAfterHoursRate: g.next() < 0.5,
  };
}

const usd = (v: string) => money(v, "USD");

/** What the server does for an estimate option: core's member discount, then core's option total. */
function serverOption(lines: OnSiteLine[], member: OnSiteMember | null) {
  const off: Money[] = member
    ? memberDiscounts(lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: usd(l.unitPrice),
        discountAmount: usd(l.discountAmount ?? "0"),
        eligible: eligibleForMemberPricing({ unitPrice: usd(l.unitPrice), itemKind: l.itemKind ?? null }),
        feeRole: (l.feeRole ?? null) as "diagnostic" | "after_hours" | null,
      })), member.rate, { diagnostic: member.waivesDiagnosticFee, afterHours: member.waivesAfterHoursRate })
    : lines.map(() => zero("USD"));
  const computed = computeOption(lines.map((l, i) => ({
    quantity: l.quantity,
    unitPrice: usd(l.unitPrice),
    discountAmount: add(usd(l.discountAmount ?? "0"), off[i]!),
    taxable: l.taxable,
    taxRate: l.taxRate,
    isOptional: l.isOptional,
    isSelected: l.isSelected,
  })));
  return { off, computed };
}

describe("the phone prices an estimate option the way the server does", () => {
  it("agrees to the cent on every line and every total, over four thousand documents", () => {
    for (let seed = 1; seed <= 4000; seed++) {
      const g = generator(seed);
      const lines = Array.from({ length: g.int(1, 8) }, () => randomLine(g));
      const member = randomMember(g);
      const phone = priceOnSite(lines, member);
      const { off, computed } = serverOption(lines, member);

      const totals = computed.totals;
      expect([phone.totals.subtotal, phone.totals.discountTotal, phone.totals.taxTotal, phone.totals.total], `seed ${seed}`)
        .toEqual([toString(totals.subtotal), toString(totals.discountTotal), toString(totals.taxTotal), toString(totals.total)]);
      for (const [i, line] of phone.lines.entries()) {
        expect(line.memberDiscount, `seed ${seed} line ${i}`).toBe(toString(off[i]!));
        expect(line.taxAmount, `seed ${seed} line ${i}`).toBe(toString(computed.lines[i]!.taxAmount));
        expect(line.lineTotal, `seed ${seed} line ${i}`).toBe(toString(computed.lines[i]!.lineTotal));
      }
    }
  });

  it("agrees with an invoice's totals when every line counts", () => {
    for (let seed = 5001; seed <= 6000; seed++) {
      const g = generator(seed);
      const lines = Array.from({ length: g.int(1, 6) }, () => ({ ...randomLine(g), isOptional: false }));
      const phone = priceOnSite(lines, null);
      const { totals } = computeInvoice(lines.map((l) => ({
        quantity: l.quantity, unitPrice: usd(l.unitPrice), discountAmount: usd(l.discountAmount ?? "0"),
        taxable: l.taxable, taxRate: l.taxRate,
      })));
      expect(phone.totals.total, `seed ${seed}`).toBe(toString(totals.total));
      expect(phone.totals.taxTotal, `seed ${seed}`).toBe(toString(totals.taxTotal));
    }
  });

  it("shows a line the office priced as priced, without taking the member's part off twice", () => {
    const priced = priceOnSite([{
      quantity: "1", unitPrice: "200.00", discountAmount: "20.00", memberDiscountAmount: "20.00",
      taxable: false, taxRate: "0",
    }], { rate: "0.1", waivesDiagnosticFee: false, waivesAfterHoursRate: false });
    expect(priced.totals.total).toBe("180.0000");
    expect(priced.totals.memberSavings).toBe("20.0000");
  });

  it("waives a diagnostic fee whole for a plan that waives it", () => {
    const priced = priceOnSite([
      { quantity: "1", unitPrice: "89.00", taxable: false, taxRate: "0", feeRole: "diagnostic", itemKind: "fee" },
      { quantity: "1", unitPrice: "100.00", taxable: false, taxRate: "0", itemKind: "service" },
    ], { rate: "0.15", waivesDiagnosticFee: true, waivesAfterHoursRate: false });
    expect(priced.lines.map((l) => l.memberDiscount)).toEqual(["89.0000", "15.0000"]);
    expect(priced.totals.total).toBe("85.0000");
  });
});

describe("the small helpers", () => {
  it("suggests the tips the portal suggests, to the cent", () => {
    for (const amount of ["162.00", "1999.99", "0.35", "4210.0000", "87.4950"]) {
      const portal = portalTipChoices(money(amount), [10, 15, 18, 20, 25]).map((c) => ({ percent: c.percent, amount: toString(c.amount) }));
      expect(tipChoices(amount, [10, 15, 18, 20, 25])).toEqual(portal);
    }
  });

  it("adds a tip to a payment exactly", () => {
    expect(addAmounts("162.00", "24.30")).toBe("186.3000");
    expect(addAmounts("0.1", "0.2")).toBe("0.3000");
  });

  it("never discounts a discount item or a free line", () => {
    expect(memberEligible({ unitPrice: "0", itemKind: "service" })).toBe(false);
    expect(memberEligible({ unitPrice: "-10", itemKind: null })).toBe(false);
    expect(memberEligible({ unitPrice: "25", itemKind: "discount" })).toBe(false);
    expect(memberEligible({ unitPrice: "25", itemKind: null })).toBe(true);
  });

  it("compares amounts to the cent", () => {
    expect(sameAmount("4210", "4210.0000")).toBe(true);
    expect(sameAmount("4210.004", "4210.00")).toBe(true);
    expect(sameAmount("4210.01", "4210.00")).toBe(false);
  });

  it("turns a typed percentage into the fraction a line carries", () => {
    expect(rateFromPercent("8.25")).toBe("0.0825");
    expect(rateFromPercent("7")).toBe("0.07");
    expect(rateFromPercent("6.875%")).toBe("0.06875");
    expect(rateFromPercent("")).toBe("0");
    expect(rateFromPercent("0")).toBe("0");
    expect(rateFromPercent("eight")).toBeNull();
    expect(rateFromPercent("150")).toBeNull();
  });
});
