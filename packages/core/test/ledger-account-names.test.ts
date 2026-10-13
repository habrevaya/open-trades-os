import { describe, it, expect } from "vitest";
import { ACCOUNTS, ACCOUNT_NAMES, accountName } from "../src/ledger/index.js";

/**
 * The names the accounting settings screen puts beside each code, so a person
 * mapping the chart is not asked to know it by heart. Every account the
 * product posts to has one, and a code a company added itself has none rather
 * than a guess.
 */
describe("the product's own accounts have names", () => {
  it("names every account in the chart", () => {
    const unnamed = Object.values(ACCOUNTS).filter((code) => !ACCOUNT_NAMES[code]);
    expect(unnamed).toEqual([]);
  });

  it("answers null for a code it does not know, and ignores spaces around one it does", () => {
    expect(accountName(" 4000 ")).toBe("Revenue from work");
    expect(accountName("4150")).toBeNull();
  });
});
