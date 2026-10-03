import { describe, it, expect } from "vitest";
import { ledger, money as m } from "../src/index";

describe("a manual journal", () => {
  it("balances and becomes a posting", () => {
    const checked = ledger.checkJournal([
      { accountCode: "6500", debit: "1200", memo: "October rent" },
      { accountCode: "1000", credit: "1200" },
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(m.toString(checked.total)).toBe("1200.0000");
    const posting = ledger.postJournal({ journalId: "j1", occurredAt: new Date(), entries: checked.entries });
    expect(posting.sourceType).toBe("journal");
    expect(posting.entries[0]!.memo).toBe("October rent");
  });

  it("names the imbalance and which side is heavier", () => {
    const checked = ledger.checkJournal([
      { accountCode: "6500", debit: "1200" },
      { accountCode: "1000", credit: "1160" },
    ]);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems[0]!.message).toContain("debits are more by 40.0000");
  });

  it("refuses each bad line by number, all at once", () => {
    const checked = ledger.checkJournal([
      { accountCode: "6500", debit: "10", credit: "10" },
      { accountCode: "12x", debit: "10" },
      { accountCode: "1200", credit: "10" },
      { accountCode: "1000", credit: "0" },
    ]);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((p) => p.line)).toEqual([1, 2, 3, 4]);
    expect(checked.problems[2]!.message).toContain("cannot take a journal");
  });

  it("refuses a single line", () => {
    expect(ledger.checkJournal([{ accountCode: "6500", debit: "10" }]).ok).toBe(false);
  });

  it("is reversed line for line, each pointing at what it takes back", () => {
    const posting = ledger.reverseJournal({
      journalId: "j2", occurredAt: new Date(), memo: "Reverses journal 1",
      original: [
        { id: "e1", direction: "debit", accountCode: "6500", amount: m.money("1200") },
        { id: "e2", direction: "credit", accountCode: "1000", amount: m.money("1200") },
      ],
    });
    expect(posting.entries.map((e) => [e.direction, e.accountCode, e.reversesEntryId])).toEqual([
      ["credit", "6500", "e1"], ["debit", "1000", "e2"],
    ]);
  });
});
