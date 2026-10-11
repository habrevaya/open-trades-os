import { describe, it, expect } from "vitest";
import {
  checkParts, partsFor, splitTax, withParts, byRate, type RatePart, type RateTotal,
} from "../src/tax/index.js";
import {
  postInvoice, postVoid, postAgreementBilling, ACCOUNTS, UnbalancedPostingError, imbalanceOf,
} from "../src/ledger/index.js";
import { money, toString, sum, subtract, abs, compare, multiply, type Money } from "../src/money/index.js";

const usd = (v: string) => money(v, "USD");

/** Austin: the state's 6.25%, Travis County's 1% and the city's 1%, charged as 8.25%. */
const AUSTIN: RatePart[] = [
  { name: "Texas", rate: "0.0625" },
  { name: "Travis County", rate: "0.01" },
  { name: "City of Austin", rate: "0.01" },
];

describe("a rate written down in parts", () => {
  it("charges the sum of its parts", () => {
    const checked = checkParts([
      { name: "Texas", percent: "6.25" }, { name: "Travis County", percent: "1" }, { name: "City of Austin", percent: "1%" },
    ]);
    expect(checked).toEqual({ ok: true, rate: "0.0825", parts: AUSTIN });
  });

  it("accepts the whole rate typed as well, when it is the sum", () => {
    const checked = checkParts([{ name: "Texas", percent: "6.25" }, { name: "Travis County", percent: "2" }], "8.25");
    expect(checked.ok).toBe(true);
  });

  it("refuses a whole rate the parts do not add up to, in words", () => {
    const checked = checkParts([{ name: "Texas", percent: "6.25" }, { name: "Travis County", percent: "2" }], "8.5");
    expect(checked).toMatchObject({ ok: false });
    expect(!checked.ok && checked.reason).toContain("add up to 8.25%");
  });

  it("refuses a part with no name, two parts with one name, a part of nothing, and parts of 100% or more", () => {
    expect(checkParts([{ name: " ", percent: "1" }]).ok).toBe(false);
    expect(checkParts([{ name: "Texas", percent: "1" }, { name: "texas", percent: "2" }]).ok).toBe(false);
    expect(checkParts([{ name: "Texas", percent: "0" }]).ok).toBe(false);
    expect(checkParts([{ name: "A", percent: "60" }, { name: "B", percent: "40" }]).ok).toBe(false);
    expect(checkParts([]).ok).toBe(false);
    expect(checkParts([{ name: "Texas", percent: "6.25555" }]).ok).toBe(false);
  });

  it("takes the parts of the version that charged the percentage, the one in force first", () => {
    const versions = [
      { rate: "0.0825", effectiveFrom: "2020-01-01", parts: AUSTIN },
      { rate: "0.085", effectiveFrom: "2026-07-01", parts: [{ name: "Texas", rate: "0.0625" }, { name: "Travis County", rate: "0.0225" }] },
    ];
    expect(partsFor(versions, "0.085", "2026-08-01").map((p) => p.name)).toEqual(["Texas", "Travis County"]);
    /** A credit in August for a sale charged at the old percentage takes the old parts. */
    expect(partsFor(versions, "0.0825", "2026-08-01")).toEqual(AUSTIN);
    expect(partsFor(versions, "0.07", "2026-08-01")).toEqual([]);
    expect(partsFor([{ rate: "0.0825", effectiveFrom: "2020-01-01" }], "0.0825", "2026-08-01")).toEqual([]);
  });
});

describe("a rate's tax shared between its parts", () => {
  it("adds up to the cent, each part within a cent of its exact share", () => {
    const shares = splitTax(usd("82.51"), AUSTIN);
    expect(toString(sum(shares))).toBe("82.5100");
    const exact = ["62.5076", "10.0012", "10.0012"].map(usd);
    for (const [i, share] of shares.entries()) {
      expect(compare(abs(subtract(share, exact[i]!)), usd("0.01"))).toBeLessThan(0);
      expect(share.amount % 100n).toBe(0n);
    }
  });

  it("gives the leftover cent to the largest remainder, the first part on a tie", () => {
    /** 0.03 shared 1:1:1 is one each; 0.02 shared 1:1:1 goes to the first two. */
    const even: RatePart[] = [{ name: "A", rate: "0.01" }, { name: "B", rate: "0.01" }, { name: "C", rate: "0.01" }];
    expect(splitTax(usd("0.02"), even).map(toString)).toEqual(["0.0100", "0.0100", "0.0000"]);
    /** 1.00 at 6.25:1:1 is 75.7575..., 12.1212..., 12.1212...: the cent goes to the state's .7575. */
    expect(splitTax(usd("1.00"), AUSTIN).map(toString)).toEqual(["0.7600", "0.1200", "0.1200"]);
  });

  it("shares a negative figure the same way, signs kept", () => {
    const shares = splitTax(usd("-82.51"), AUSTIN);
    expect(toString(sum(shares))).toBe("-82.5100");
    expect(shares.every((s) => s.amount <= 0n)).toBe(true);
  });

  it("keeps a figure below the cent on the part with the largest remainder", () => {
    const shares = splitTax(usd("10.0050"), AUSTIN);
    expect(toString(sum(shares))).toBe("10.0050");
  });

  it("splits a row whose rate is the sum of the parts, and leaves any other row as it was", () => {
    const row: RateTotal = { taxRateId: "austin", rate: "0.0825", base: usd("1000.00"), tax: usd("82.50") };
    const split = withParts(row, AUSTIN);
    expect(split.parts?.map((p) => [p.name, p.rate, toString(p.tax)])).toEqual([
      ["Texas", "0.0625", "62.5000"], ["Travis County", "0.01", "10.0000"], ["City of Austin", "0.01", "10.0000"],
    ]);
    expect(withParts({ ...row, rate: "0.085" }, AUSTIN).parts).toBeUndefined();
    expect(withParts(row, []).parts).toBeUndefined();
  });
});

describe("posting a rate in parts", () => {
  const totals = (taxTotal: string, subtotal = "1000.00") => {
    const tax = usd(taxTotal);
    const sub = usd(subtotal);
    return { subtotal: sub, discountTotal: usd("0"), taxTotal: tax, total: { amount: sub.amount + tax.amount, currency: "USD" } };
  };

  it("posts sales tax payable one entry per part, balanced, each naming its jurisdiction", () => {
    const rows = byRate([{ taxable: true, taxRate: "0.0825", taxRateId: "austin", base: usd("1000.00"), tax: usd("82.50") }], usd("82.50"))
      .map((r) => withParts(r, AUSTIN));
    const posting = postInvoice({ invoiceId: "i1", occurredAt: new Date(), totals: totals("82.50"), taxByRate: rows });
    expect(toString(imbalanceOf(posting.entries))).toBe("0.0000");
    const tax = posting.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE);
    expect(tax.map((e) => [e.metadata?.["part"], toString(e.amount)])).toEqual([
      ["Texas", "62.5000"], ["Travis County", "10.0000"], ["City of Austin", "10.0000"],
    ]);
    /** The sales are on one part only, so the report by rate counts them once. */
    expect(tax.filter((e) => e.metadata?.["taxableBase"] !== undefined)).toHaveLength(1);
    expect(tax.every((e) => e.metadata?.["partBase"] === "1000.0000" && e.metadata?.["taxRateId"] === "austin")).toBe(true);
  });

  it("puts the sales on the first part that posts anything", () => {
    const row = withParts({ taxRateId: "x", rate: "0.03", base: usd("0.33"), tax: usd("0.01") },
      [{ name: "A", rate: "0.01" }, { name: "B", rate: "0.02" }]);
    expect(row.parts?.map((p) => toString(p.tax))).toEqual(["0.0000", "0.0100"]);
    const posting = postInvoice({ invoiceId: "i2", occurredAt: new Date(), totals: totals("0.01", "0.33"), taxByRate: [row] });
    const tax = posting.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE);
    expect(tax).toHaveLength(1);
    expect(tax[0]!.metadata).toMatchObject({ part: "B", taxableBase: "0.3300" });
  });

  it("refuses parts that do not add up to the rate's tax", () => {
    const row: RateTotal = {
      taxRateId: "austin", rate: "0.0825", base: usd("1000.00"), tax: usd("82.50"),
      parts: [{ name: "Texas", rate: "0.0625", tax: usd("62.50") }, { name: "Travis County", rate: "0.02", tax: usd("20.01") }],
    };
    expect(() => postInvoice({ invoiceId: "i3", occurredAt: new Date(), totals: totals("82.50"), taxByRate: [row] }))
      .toThrow(UnbalancedPostingError);
  });

  it("takes back each part on a void exactly as it was posted", () => {
    const rows = [withParts({ taxRateId: "austin", rate: "0.0825", base: usd("1000.00"), tax: usd("82.50") }, AUSTIN)];
    const issued = postInvoice({ invoiceId: "i4", occurredAt: new Date(), totals: totals("82.50"), taxByRate: rows });
    const voided = postVoid({ invoiceId: "i4", occurredAt: new Date(), totals: totals("82.50"), taxByRate: rows });
    const net = new Map<string, bigint>();
    for (const e of [...issued.entries, ...voided.entries].filter((x) => x.accountCode === ACCOUNTS.TAX_PAYABLE)) {
      const key = String(e.metadata?.["part"]);
      net.set(key, (net.get(key) ?? 0n) + (e.direction === "credit" ? e.amount.amount : -e.amount.amount));
    }
    expect([...net.values()].every((v) => v === 0n)).toBe(true);
  });

  it("posts an agreement instalment's tax on its rate and parts, and as one figure without rates", () => {
    const rows = [withParts({ taxRateId: "austin", rate: "0.0825", base: usd("228.00"), tax: usd("18.81") }, AUSTIN)];
    const posting = postAgreementBilling({
      invoiceId: "a1", occurredAt: new Date(), amount: usd("228.00"), taxAmount: usd("18.81"), taxByRate: rows,
    });
    expect(toString(imbalanceOf(posting.entries))).toBe("0.0000");
    const tax = posting.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE);
    expect(tax.map((e) => e.metadata?.["part"])).toEqual(["Texas", "Travis County", "City of Austin"]);
    expect(toString(sum(tax.map((e) => e.amount)))).toBe("18.8100");

    const plain = postAgreementBilling({ invoiceId: "a2", occurredAt: new Date(), amount: usd("228.00"), taxAmount: usd("18.81") });
    expect(plain.entries.filter((e) => e.accountCode === ACCOUNTS.TAX_PAYABLE)).toHaveLength(1);
  });

  it("keeps every random rate in parts adding up to its tax and every posting balanced", () => {
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    for (let n = 0; n < 300; n += 1) {
      const count = 1 + (next() % 4);
      const parts: RatePart[] = Array.from({ length: count }, (_, i) => ({
        name: `P${i}`, rate: `0.${String(1 + (next() % 4999)).padStart(6, "0")}`,
      }));
      const rate = checkParts(parts.map((p) => ({ name: p.name, percent: String(Number(p.rate) * 100) })));
      if (!rate.ok) continue;
      const base = usd(`${next() % 5000}.${String(next() % 100).padStart(2, "0")}`);
      const tax = multiply(base, rate.rate);
      const cents = usd(toString(tax).replace(/(\.\d{2})\d+$/, "$1"));
      const row = withParts({ taxRateId: "r", rate: rate.rate, base, tax: cents }, rate.parts);
      const shares: Money[] = (row.parts ?? []).map((p) => p.tax);
      expect(toString(sum(shares))).toBe(toString(cents));
      const posting = postInvoice({
        invoiceId: `r${n}`, occurredAt: new Date(), totals: totals(toString(cents), toString(base)), taxByRate: [row],
      });
      expect(toString(imbalanceOf(posting.entries))).toBe("0.0000");
    }
  });
});
