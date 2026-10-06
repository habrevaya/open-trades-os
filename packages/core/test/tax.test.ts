import { describe, it, expect } from "vitest";
import {
  resolve, versionOn, rateOn, percentToRate, rateToPercent, canonical, sameRate, describe as describeRate,
  nameTyped, chosen, defaultTaxable, onLine, exemptOn, shareTax, byRate, tableProvider, isTableSource,
  EMPTY_TABLE, type TaxTable, type TaxParty,
} from "../src/tax/index.js";
import {
  computeInvoice, postInvoice, postVoid, postCreditNote, postCreditNoteVoid, ACCOUNTS,
  UnbalancedPostingError, imbalanceOf,
} from "../src/ledger/index.js";
import { money, toString, sum, subtract, abs, compare, multiply, type Money } from "../src/money/index.js";

const usd = (v: string) => money(v, "USD");

const TRAVIS = {
  id: "travis", name: "Travis County", retired: false,
  versions: [{ rate: "0.0825", effectiveFrom: "2020-01-01" }, { rate: "0.085", effectiveFrom: "2026-07-01" }],
};
const ROUND_ROCK = { id: "rr", name: "Round Rock", retired: false, versions: [{ rate: "0.0825", effectiveFrom: "2020-01-01" }] };
const LATER = { id: "later", name: "New district", retired: false, versions: [{ rate: "0.09", effectiveFrom: "2027-01-01" }] };
const OLD = { id: "old", name: "Old rate", retired: true, versions: [{ rate: "0.07", effectiveFrom: "2019-01-01" }] };

const TABLE: TaxTable = { chargesTax: true, defaultRateId: "travis", rates: [TRAVIS, ROUND_ROCK, LATER, OLD] };

const party = (over: Partial<TaxParty> = {}): TaxParty => ({
  exemption: { exempt: false, certificate: null, expiresOn: null },
  customerRateId: null,
  addressRateId: null,
  ...over,
});

describe("the rate in force on a day", () => {
  it("is the latest that started on or before it", () => {
    expect(versionOn(TRAVIS.versions, "2026-06-30")?.rate).toBe("0.0825");
    expect(versionOn(TRAVIS.versions, "2026-07-01")?.rate).toBe("0.085");
    expect(versionOn(TRAVIS.versions, "2019-12-31")).toBeNull();
  });

  it("is nothing for a retired rate", () => {
    expect(rateOn(OLD, "2026-01-01")).toBeNull();
    expect(rateOn(undefined, "2026-01-01")).toBeNull();
  });
});

describe("which rate a sale is charged", () => {
  it("charges nothing for a company that says it charges no sales tax", () => {
    const r = resolve({ ...TABLE, chargesTax: false }, party({ addressRateId: "rr" }), "2026-03-01");
    expect(r).toMatchObject({ rate: "0", source: "off", taxRateId: null });
  });

  it("charges an exempt customer nothing, and says on what certificate", () => {
    const r = resolve(TABLE, party({ exemption: { exempt: true, certificate: "TX-1234", expiresOn: "2026-12-31" } }), "2026-03-01");
    expect(r).toMatchObject({ rate: "0", source: "exempt" });
    expect(r.note).toContain("TX-1234");
  });

  it("taxes a customer whose certificate has lapsed, and says so", () => {
    const r = resolve(TABLE, party({ exemption: { exempt: true, certificate: "TX-1234", expiresOn: "2026-02-28" } }), "2026-03-01");
    expect(r).toMatchObject({ rate: "0.0825", source: "default", taxRateId: "travis" });
    expect(r.note).toContain("ran out on 2026-02-28");
    expect(exemptOn({ exempt: true, certificate: null, expiresOn: "2026-03-01" }, "2026-03-01")).toEqual({ exempt: true, lapsed: false });
  });

  it("takes the address's rate over the customer's, the customer's over the default", () => {
    expect(resolve(TABLE, party({ addressRateId: "rr", customerRateId: "travis" }), "2026-03-01"))
      .toMatchObject({ taxRateId: "rr", source: "address" });
    expect(resolve(TABLE, party({ customerRateId: "rr" }), "2026-03-01")).toMatchObject({ taxRateId: "rr", source: "customer" });
    expect(resolve(TABLE, party(), "2026-03-01")).toMatchObject({ taxRateId: "travis", source: "default", rate: "0.0825" });
  });

  it("charges the percentage in force on the day of the sale", () => {
    expect(resolve(TABLE, party(), "2026-06-30").rate).toBe("0.0825");
    expect(resolve(TABLE, party(), "2026-07-01").rate).toBe("0.085");
  });

  it("passes over a rate not yet in force, or retired, to the next step", () => {
    expect(resolve(TABLE, party({ addressRateId: "later" }), "2026-03-01")).toMatchObject({ taxRateId: "travis", source: "default" });
    expect(resolve(TABLE, party({ customerRateId: "old" }), "2026-03-01")).toMatchObject({ taxRateId: "travis", source: "default" });
  });

  it("charges nothing when nothing applies, which is every company that has said nothing", () => {
    expect(resolve(EMPTY_TABLE, party(), "2026-03-01")).toMatchObject({ rate: "0", source: "none" });
    expect(resolve({ ...TABLE, defaultRateId: null }, party(), "2026-03-01")).toMatchObject({ rate: "0", source: "none" });
  });

  it("puts nothing on a line that is not taxable", () => {
    const r = resolve(TABLE, party(), "2026-03-01");
    expect(onLine(r, false)).toEqual({ taxRate: "0", taxRateId: null, taxSource: null });
    expect(onLine(r, true)).toEqual({ taxRate: "0.0825", taxRateId: "travis", taxSource: "default" });
  });

  it("answers a rate somebody chose only when it is in force", () => {
    expect(chosen(TABLE, "rr", "2026-03-01")).toMatchObject({ rate: "0.0825", source: "chosen" });
    expect(chosen(TABLE, "later", "2026-03-01")).toBeNull();
    expect(chosen(TABLE, "old", "2026-03-01")).toBeNull();
  });

  it("is the table's answer through the provider seam", async () => {
    const provider = tableProvider(TABLE);
    expect(provider.name).toBe("table");
    expect(await provider.rateFor({ on: "2026-03-01", party: party({ addressRateId: "rr" }), address: null }))
      .toEqual(resolve(TABLE, party({ addressRateId: "rr" }), "2026-03-01"));
  });

  it("knows which outcomes are the table's to decide again", () => {
    expect(["address", "customer", "default", "exempt", "none", "off"].every(isTableSource)).toBe(true);
    expect(["chosen", "estimate", "given", null].some(isTableSource)).toBe(false);
  });
});

describe("percentages", () => {
  it.each([
    ["8.25", "0.0825"], ["8.25%", "0.0825"], ["0", "0"], ["6.875", "0.06875"], ["10", "0.1"], ["7.0625", "0.070625"],
  ])("reads %s as %s", (typed, rate) => {
    expect(percentToRate(typed)).toEqual({ ok: true, rate });
  });

  it.each(["100", "-1", "8.12345", "eight", ""])("refuses %s", (typed) => {
    expect(percentToRate(typed).ok).toBe(false);
  });

  it("reads a fraction back as a percentage", () => {
    expect(rateToPercent("0.082500")).toBe("8.25");
    expect(rateToPercent("0.070625")).toBe("7.0625");
    expect(rateToPercent("0")).toBe("0");
    expect(describeRate("Travis County", "0.0825")).toBe("Travis County 8.25%");
    expect(canonical("0.082500")).toBe("0.0825");
    expect(sameRate("0.0825", "0.082500")).toBe(true);
    expect(sameRate("0.0825", "0.0826")).toBe(false);
  });

  it("names a typed rate for the company's rate it is, preferring the one the sale would get", () => {
    expect(nameTyped(TABLE, "0.0825", "2026-03-01", "rr")).toBe("rr");
    expect(nameTyped(TABLE, "0.0825", "2026-03-01")).toBe("travis");
    expect(nameTyped(TABLE, "0.0625", "2026-03-01")).toBeNull();
    expect(nameTyped(TABLE, "0", "2026-03-01")).toBeNull();
  });
});

describe("labour and parts", () => {
  it("taxes a part and not labour when nobody said", () => {
    expect(defaultTaxable("labor")).toBe(false);
    expect(defaultTaxable("labour")).toBe(false);
    expect(defaultTaxable("material")).toBe(true);
    expect(defaultTaxable("part")).toBe(true);
    expect(defaultTaxable(null)).toBe(true);
  });
});

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

describe("an invoice's tax and its lines", () => {
  it("shares the rounded tax so the lines add up to it, each within a cent of exact", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const g = generator(seed);
      const lines = Array.from({ length: g.int(1, 9) }, () => ({
        quantity: g.pick(["1", "2", "3", "0.5", "1.25", "2.333"]),
        unitPrice: usd(g.pick([dollars(g.int(0, 90_000)), "10.05", "0.07", "0.1875"])),
        discountAmount: usd(g.next() < 0.2 ? dollars(g.int(0, 500)) : "0"),
        taxable: g.next() < 0.7,
        taxRate: g.pick(["0", "0.0825", "0.07", "0.06875", "0.1", "0.085"]),
      }));
      const { lines: out, totals } = computeInvoice(lines);
      expect(toString(sum(out.map((l) => l.taxAmount), "USD")), `seed ${seed}`).toBe(toString(totals.taxTotal));
      for (const [i, line] of out.entries()) {
        const exact = lines[i]!.taxable
          ? multiply(subtract(multiply(lines[i]!.unitPrice, lines[i]!.quantity), lines[i]!.discountAmount), lines[i]!.taxRate)
          : usd("0");
        expect(compare(abs(subtract(line.taxAmount, exact)), usd("0.01")), `seed ${seed} line ${i}`).toBeLessThan(0);
        expect(line.taxAmount.amount % 100n, `seed ${seed} line ${i}`).toBe(0n);
      }
    }
  });

  it("gives the leftover cent to the line with the most left over", () => {
    // Four lines at 8.25% on 10.05 are 0.829125 each: 3.3165 in all, 3.32 rounded.
    const lines = Array.from({ length: 4 }, () => ({ quantity: "1", unitPrice: usd("10.05"), taxable: true, taxRate: "0.0825" }));
    const { lines: out, totals } = computeInvoice(lines);
    expect(toString(totals.taxTotal)).toBe("3.3200");
    expect(out.map((l) => toString(l.taxAmount))).toEqual(["0.8300", "0.8300", "0.8300", "0.8300"]);
    const shared = shareTax([usd("0.004"), usd("0.004"), usd("0.002")], usd("0.01"));
    expect(shared.map(toString)).toEqual(["0.0100", "0.0000", "0.0000"]);
  });

  it("keeps a stated tax as it was charged", () => {
    const line = { quantity: "1", unitPrice: usd("10.05"), taxable: true, taxRate: "0.0825", taxAmount: usd("0.82") };
    const { lines, totals } = computeInvoice([line, line, line, line]);
    expect(lines.map((l) => toString(l.taxAmount))).toEqual(["0.8200", "0.8200", "0.8200", "0.8200"]);
    expect(toString(totals.taxTotal)).toBe("3.2800");
  });
});

describe("tax by rate", () => {
  const lines = [
    { taxable: true, taxRate: "0.0825", taxRateId: "travis", base: usd("100.00"), tax: usd("8.25") },
    { taxable: true, taxRate: "0.082500", taxRateId: "travis", base: usd("50.00"), tax: usd("4.13") },
    { taxable: true, taxRate: "0.0625", taxRateId: "state", base: usd("10.00"), tax: usd("0.62") },
    { taxable: false, taxRate: "0", taxRateId: null, base: usd("80.00"), tax: usd("0") },
    { taxable: true, taxRate: "0", taxRateId: null, base: usd("20.00"), tax: usd("0") },
  ];

  it("groups by the company's rate and the percentage, leaving out what charged nothing", () => {
    const rows = byRate(lines, usd("13.00"));
    expect(rows.map((r) => [r.taxRateId, r.rate, toString(r.base), toString(r.tax)])).toEqual([
      ["travis", "0.0825", "150.0000", "12.3800"],
      ["state", "0.0625", "10.0000", "0.6200"],
    ]);
  });

  it("puts history's stray cent on the largest row, so the rows still add up", () => {
    const rows = byRate(lines, usd("13.01"));
    expect(toString(sum(rows.map((r) => r.tax), "USD"))).toBe("13.0100");
    expect(toString(rows[0]!.tax)).toBe("12.3900");
  });

  it("posts one sales tax entry per rate, balanced, carrying the rate and its sales", () => {
    const totals = { subtotal: usd("260.00"), discountTotal: usd("0"), taxTotal: usd("13.00"), total: usd("273.00") };
    const taxByRate = byRate(lines, totals.taxTotal);
    const posting = postInvoice({ invoiceId: "i1", occurredAt: new Date(), totals, taxByRate });
    expect(toString(imbalanceOf(posting.entries))).toBe("0.0000");
    const taxes = posting.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE);
    expect(taxes.map((e) => [e.direction, toString(e.amount), e.metadata])).toEqual([
      ["credit", "12.3800", { taxRateId: "travis", taxRate: "0.0825", taxableBase: "150.0000" }],
      ["credit", "0.6200", { taxRateId: "state", taxRate: "0.0625", taxableBase: "10.0000" }],
    ]);

    const voided = postVoid({ invoiceId: "i1", occurredAt: new Date(), totals, taxByRate });
    expect(toString(imbalanceOf(voided.entries))).toBe("0.0000");
    expect(voided.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE).map((e) => [e.direction, toString(e.amount)]))
      .toEqual([["debit", "12.3800"], ["debit", "0.6200"]]);

    const credited = { subtotal: usd("160.00"), taxTotal: usd("13.00"), total: usd("173.00") };
    for (const p of [
      postCreditNote({ creditNoteId: "c1", occurredAt: new Date(), totals: credited, taxByRate }),
      postCreditNoteVoid({ creditNoteId: "c1", occurredAt: new Date(), totals: credited, taxByRate }),
    ]) {
      expect(toString(imbalanceOf(p.entries))).toBe("0.0000");
      expect(p.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE)).toHaveLength(2);
    }
  });

  it("refuses rates that do not add up to the document's tax", () => {
    const totals = { subtotal: usd("260.00"), discountTotal: usd("0"), taxTotal: usd("13.05"), total: usd("273.05") };
    expect(() => postInvoice({ invoiceId: "i1", occurredAt: new Date(), totals, taxByRate: byRate(lines, usd("13.00")) }))
      .toThrow(UnbalancedPostingError);
  });

  it("posts one entry, as before, when no rates are given", () => {
    const totals = { subtotal: usd("100.00"), discountTotal: usd("0"), taxTotal: usd("8.25"), total: usd("108.25") };
    const posting = postInvoice({ invoiceId: "i1", occurredAt: new Date(), totals });
    const taxes = posting.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE);
    expect(taxes).toHaveLength(1);
    expect(taxes[0]!.metadata).toBeUndefined();
  });

  it("keeps every random two rate invoice balanced and its rates adding up to its tax", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const g = generator(seed);
      const raw = Array.from({ length: g.int(1, 8) }, () => {
        const id = g.pick(["travis", "state", null]);
        return {
          quantity: g.pick(["1", "2", "0.5", "3"]),
          unitPrice: usd(dollars(g.int(0, 50_000))),
          taxable: g.next() < 0.8,
          taxRate: id === "travis" ? "0.0825" : id === "state" ? "0.0625" : g.pick(["0", "0.07"]),
          taxRateId: id,
        };
      });
      const computed = computeInvoice(raw);
      const rows = byRate(raw.map((l, i) => ({
        taxable: l.taxable, taxRate: l.taxRate, taxRateId: l.taxRateId,
        base: computed.lines[i]!.lineTotal, tax: computed.lines[i]!.taxAmount,
      })), computed.totals.taxTotal);
      const posting = postInvoice({ invoiceId: "x", occurredAt: new Date(), totals: computed.totals, taxByRate: rows });
      expect(toString(imbalanceOf(posting.entries)), `seed ${seed}`).toBe("0.0000");
      const posted: Money = sum(posting.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE).map((e) => e.amount), "USD");
      expect(toString(posted), `seed ${seed}`).toBe(toString(computed.totals.taxTotal));
    }
  });
});
