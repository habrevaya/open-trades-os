import { describe, it, expect } from "vitest";
import { rates, money as m } from "../src/index";

/**
 * WHOSE PRICE GOVERNS A LINE
 *
 * A commercial schedule is mostly rules: an hourly rate per trade and time of
 * day, a markup on materials, a trip charge, and a short list of flat prices.
 * These tests are about which rule prices which line, and about the two
 * failures that cost real money: a premium charged that the card never
 * agreed, and a line quietly priced at our list when a card applies.
 */
const usd = (v: string) => m.money(v, "USD");
const ZONE = "America/Chicago";

const bands: rates.BandRules = {
  standardDays: [1, 2, 3, 4, 5],
  standardStartMinute: 7 * 60,
  standardEndMinute: 17 * 60,
  holidays: ["2026-12-25"],
  timeZone: ZONE,
};

/** Tuesday 6 October 2026 at a local time, in Chicago (UTC minus five). */
const tuesday = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 6, hh + 5, mm));
const saturday = (hh: number) => new Date(Date.UTC(2026, 9, 10, hh + 5, 0));

const PLUMBING = "11111111-1111-4111-8111-111111111111";

const card = (over: Partial<rates.CardTerms> = {}): rates.CardTerms => ({
  id: "card-1",
  name: "Meridian FM schedule",
  authority: "contract",
  lines: [{
    id: "line-1", priceBookItemId: "item-cap", externalCode: "CAP-01",
    description: "Capacitor, supplied and fitted", price: usd("180.00"), allowedMinutes: null,
  }],
  labourRates: [
    { jobTypeId: null, band: "standard", hourlyRate: usd("95.00"), minimumMinutes: 60, incrementMinutes: 15 },
    { jobTypeId: null, band: "after_hours", hourlyRate: usd("142.50"), minimumMinutes: 120, incrementMinutes: 15 },
    { jobTypeId: PLUMBING, band: "standard", hourlyRate: usd("110.00"), minimumMinutes: 60, incrementMinutes: 15 },
  ],
  markup: [
    { upToCost: usd("100.00"), percent: "0.5" },
    { upToCost: null, percent: "0.2" },
  ],
  tripCharge: usd("45.00"),
  bands,
  ...over,
});

const work = (over: Partial<rates.WorkLine>): rates.WorkLine => ({
  kind: "part", name: "A thing", priceBookItemId: null, quantity: "1",
  ourPrice: usd("289.00"), ourPriceIsBook: true, unitCost: null,
  at: tuesday(10), jobTypeId: null,
  ...over,
});

describe("the time band", () => {
  it("is the card's own hours, not the office's", () => {
    expect(rates.bandAt(bands, tuesday(10))).toBe("standard");
    expect(rates.bandAt(bands, tuesday(6, 59))).toBe("after_hours");
    expect(rates.bandAt(bands, tuesday(17))).toBe("after_hours");
    expect(rates.bandAt(bands, saturday(10))).toBe("weekend");
  });

  it("calls a holiday a holiday, even on a weekday", () => {
    expect(rates.bandAt(bands, new Date(Date.UTC(2026, 11, 25, 16)))).toBe("holiday");
  });

  it("reads the local day, not the UTC one", () => {
    /** Ten at night on a Friday in Chicago is already Saturday in UTC. */
    const fridayNight = new Date(Date.UTC(2026, 9, 10, 3, 0));
    expect(rates.bandAt(bands, fridayNight)).toBe("after_hours");
  });

  it("refuses a day that ends before it starts", () => {
    expect(rates.bandRulesProblem({ ...bands, standardStartMinute: 600, standardEndMinute: 540 })).toMatch(/end after they start/);
    expect(rates.bandRulesProblem({ ...bands, holidays: ["Christmas"] })).toMatch(/not a date/);
    expect(rates.bandRulesProblem(bands)).toBeNull();
  });
});

describe("labour", () => {
  it("charges the minimum, then rounds up to the increment", () => {
    expect(rates.billableMinutes(20, 60, 15)).toBe(60);
    expect(rates.billableMinutes(61, 60, 15)).toBe(75);
    expect(rates.billableMinutes(90, null, null)).toBe(90);
  });

  it("prices hours at the card's rate for the band the work fell in", () => {
    const priced = rates.priceWork([card()], work({ kind: "labor", quantity: "1.5", at: tuesday(10) }));
    expect(priced.basis).toBe("labour_rate");
    expect(priced.authority).toBe("contract");
    expect(priced.quantity).toBe("1.5000");
    expect(m.toString(priced.unitPrice)).toBe("95.0000");
    expect(priced.note).toMatch(/Standard hours rate: 90 min at 95.00/);
  });

  it("uses the after hours rate and its own minimum at night", () => {
    const priced = rates.priceWork([card()], work({ kind: "labor", quantity: "0.5", at: tuesday(21) }));
    expect(priced.band).toBe("after_hours");
    expect(priced.quantity).toBe("2.0000");
    expect(m.toString(priced.unitPrice)).toBe("142.5000");
    expect(priced.note).toMatch(/30 min worked/);
  });

  it("falls back DOWN to a lower band, never up to a premium nobody agreed", () => {
    /** No weekend rate on the card, so the weekend pays after hours. */
    const weekend = rates.priceWork([card()], work({ kind: "labor", quantity: "2", at: saturday(10) }));
    expect(weekend.band).toBe("after_hours");
    expect(weekend.note).toMatch(/names no weekend rate/);

    /** And a card with only a standard rate pays it whenever the work happens. */
    const plain = card({ labourRates: [{ jobTypeId: null, band: "standard", hourlyRate: usd("80"), minimumMinutes: null, incrementMinutes: null }] });
    expect(rates.priceWork([plain], work({ kind: "labor", quantity: "1", at: saturday(10) })).band).toBe("standard");
  });

  it("prefers the trade's own rate within a band", () => {
    const priced = rates.priceWork([card()], work({ kind: "labor", quantity: "1", jobTypeId: PLUMBING }));
    expect(m.toString(priced.unitPrice)).toBe("110.0000");
  });

  it("keeps the arithmetic exact when the minutes are not a clean fraction of an hour", () => {
    const odd = card({ labourRates: [{ jobTypeId: null, band: "standard", hourlyRate: usd("90"), minimumMinutes: null, incrementMinutes: null }] });
    /** 50 minutes is 0.8333 of an hour; the line is one unit at what the card pays. */
    const priced = rates.priceWork([odd], work({ kind: "labor", quantity: "0.8333", at: tuesday(10) }));
    expect(priced.quantity).toBe("1");
    expect(m.toString(priced.unitPrice)).toBe("75.0000");
  });

  it("refuses two rates for one trade and band", () => {
    expect(rates.labourRatesProblem([
      { jobTypeId: null, band: "standard", hourlyRate: usd("90"), minimumMinutes: null, incrementMinutes: null },
      { jobTypeId: null, band: "standard", hourlyRate: usd("95"), minimumMinutes: null, incrementMinutes: null },
    ])).toMatch(/Two standard hours rates/);
  });
});

describe("materials", () => {
  it("marks cost up by the band the cost falls in", () => {
    const cheap = rates.priceWork([card()], work({ unitCost: usd("40.00") }));
    expect(cheap.basis).toBe("material_markup");
    expect(m.toString(cheap.unitPrice)).toBe("60.0000");
    const dear = rates.priceWork([card()], work({ unitCost: usd("300.00") }));
    expect(m.toString(dear.unitPrice)).toBe("360.0000");
    expect(dear.note).toBe("Cost 300.00 plus 20% markup.");
  });

  it("cannot mark up a cost nobody recorded", () => {
    const priced = rates.priceWork([card()], work({ unitCost: null }));
    expect(priced.outOfScope).toBe(true);
    expect(priced.authority).toBe("price_book");
  });

  it("refuses a markup written as a percentage", () => {
    expect(rates.markupTiersProblem([{ upToCost: null, percent: "25" }])).toMatch(/fraction/);
    expect(rates.markupTiersProblem([{ upToCost: null, percent: "0.2" }, { upToCost: null, percent: "0.1" }])).toMatch(/Only one band/);
  });
});

describe("what wins", () => {
  it("takes a listed price over a markup or a rate", () => {
    const priced = rates.priceWork([card()], work({ priceBookItemId: "item-cap", unitCost: usd("18.00") }));
    expect(priced.basis).toBe("card_line");
    expect(priced.rateCardLineId).toBe("line-1");
    expect(m.toString(priced.unitPrice)).toBe("180.0000");
  });

  it("matches their code when our item is not mapped", () => {
    expect(rates.priceWork([card()], work({ externalCode: "CAP-01" })).basis).toBe("card_line");
  });

  it("charges the trip per visit", () => {
    const priced = rates.priceWork([card()], work({ kind: "trip", quantity: "2", name: "Trip" }));
    expect(priced.basis).toBe("trip_charge");
    expect(m.toString(priced.unitPrice)).toBe("45.0000");
  });

  it("marks a line the card does not price as out of scope, at our price", () => {
    const priced = rates.priceWork([card({ markup: [] })], work({ kind: "subcontractor", unitCost: usd("10") }));
    expect(priced.outOfScope).toBe(true);
    expect(m.toString(priced.unitPrice)).toBe("289.0000");
    expect(priced.note).toMatch(/Agree it with the client/);
  });

  it("flags nothing when no card applies, because our book is then the authority", () => {
    const priced = rates.priceWork([], work({}));
    expect(priced.outOfScope).toBe(false);
    expect(priced.authority).toBe("price_book");
    expect(priced.note).toBeNull();
    expect(rates.priceWork([], work({ ourPriceIsBook: false })).authority).toBe("entered");
  });
});

describe("the ceiling", () => {
  it("holds work that would go over, and says what would fit", () => {
    const verdict = rates.ceilingVerdict({
      amount: usd("400"), alreadyBilled: usd("300"), ceiling: usd("500"), action: "hold", source: "The site limit",
    });
    expect(verdict.state).toBe("over");
    expect(verdict.held).toBe(true);
    expect(m.toString(verdict.over!)).toBe("200.0000");
    expect(verdict.message).toMatch(/bill 200.00 now/);
  });

  it("lets it through on a warn contract, and still says so", () => {
    const verdict = rates.ceilingVerdict({
      amount: usd("600"), alreadyBilled: usd("0"), ceiling: usd("500"), action: "warn", source: "The limit",
    });
    expect(verdict.held).toBe(false);
    expect(verdict.message).toMatch(/question the difference/);
  });

  it("is silent with no ceiling and within one", () => {
    expect(rates.ceilingVerdict({ amount: usd("9999"), alreadyBilled: usd("0"), ceiling: null, action: "hold", source: "x" }).state).toBe("none");
    expect(rates.ceilingVerdict({ amount: usd("500"), alreadyBilled: usd("0"), ceiling: usd("500"), action: "hold", source: "x" }).state).toBe("within");
  });
});

describe("a contract's annual escalation", () => {
  const usd = (v: string) => m.money(v, "USD");
  it("finds the next anniversary after the last one applied", () => {
    expect(rates.nextAnniversary("2025-03-15", null)).toBe("2026-03-15");
    expect(rates.nextAnniversary("2025-03-15", "2026-03-15")).toBe("2027-03-15");
    expect(rates.contractYear("2025-03-15", "2027-03-15")).toBe(3);
  });

  it("keeps a leap day contract's anniversary in years without one", () => {
    expect(rates.nextAnniversary("2024-02-29", null)).toBe("2025-02-28");
    expect(rates.nextAnniversary("2024-02-29", "2027-02-28")).toBe("2028-02-29");
  });

  it("rises a price by the rate to the cent, half up, rounding once", () => {
    expect(m.toString(rates.escalate(usd("142.50"), "0.03"))).toBe("146.7800");
    expect(m.toString(rates.escalate(usd("95.00"), "0.035"))).toBe("98.3300");
    expect(m.toString(rates.escalate(usd("0.01"), "0.03"))).toBe("0.0100");
    expect(m.toString(rates.escalate(usd("142.4999"), "0.030000"))).toBe("146.7700");
  });

  it("refuses a rate that is nothing, or a percentage written as a whole number", () => {
    expect(rates.escalationRateProblem(null)).toMatch(/no annual escalation/);
    expect(rates.escalationRateProblem("0")).toMatch(/raises nothing/);
    expect(rates.escalationRateProblem("3")).toMatch(/Write 0.03/);
    expect(rates.escalationRateProblem("0.03")).toBeNull();
  });
});

describe("labour beyond a manufacturer's allowance", () => {
  /**
   * An allowance pays a listed price and allows a number of minutes; time
   * worked beyond them is offered to somebody, never added by itself, and
   * time already on a labour line is not offered twice.
   */
  it("is what was worked on site beyond what the allowance allows and what is already on a line", () => {
    expect(rates.labourBeyondAllowance({ workedMinutes: 150, allowedMinutes: 90, onLinesMinutes: 0 }).beyondMinutes).toBe(60);
    expect(rates.labourBeyondAllowance({ workedMinutes: 150, allowedMinutes: 90, onLinesMinutes: 30 }).beyondMinutes).toBe(30);
    expect(rates.labourBeyondAllowance({ workedMinutes: 80, allowedMinutes: 90, onLinesMinutes: 0 }).beyondMinutes).toBe(0);
  });

  it("carries the minutes a listed price allows", () => {
    const allowance = card({
      authority: "manufacturer_allowance",
      lines: [{ id: "l1", priceBookItemId: "item-coil", externalCode: null, description: "Coil", price: usd("210.00"), allowedMinutes: 90 }],
    });
    const priced = rates.priceWork([allowance], {
      kind: "part", name: "Coil", priceBookItemId: "item-coil", quantity: "1", ourPrice: usd("300.00"),
      ourPriceIsBook: true, unitCost: null, at: tuesday(10), jobTypeId: null,
    });
    expect(priced).toMatchObject({ basis: "card_line", allowedMinutes: 90 });
  });

  it("is priced at the payer's own hourly rate when their card has one, otherwise at the office's", () => {
    const own = rates.priceBeyondAllowance([], { minutes: 60, hourlyRate: usd("120.00"), at: tuesday(10), jobTypeId: null });
    expect(own).toMatchObject({ quantity: "1.0000", basis: "entered", outOfScope: false });
    expect(m.toString(own.unitPrice)).toBe("120.0000");
    /** Fifty minutes is not a whole number of hundredths of an hour: one line of the amount. */
    const odd = rates.priceBeyondAllowance([], { minutes: 50, hourlyRate: usd("120.00"), at: tuesday(10), jobTypeId: null });
    expect(odd.quantity).toBe("1");
    expect(m.toString(odd.unitPrice)).toBe("100.0000");
    const theirs = rates.priceBeyondAllowance([card({ labourRates: [{ jobTypeId: null, band: "standard", hourlyRate: usd("95.00"), minimumMinutes: null, incrementMinutes: null }] })],
      { minutes: 60, hourlyRate: usd("120.00"), at: tuesday(10), jobTypeId: null });
    expect(theirs.basis).toBe("labour_rate");
    expect(m.toString(theirs.unitPrice)).toBe("95.0000");
  });
});
