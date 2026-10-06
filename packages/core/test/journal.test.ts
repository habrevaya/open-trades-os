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

  it("carries a branch, a job and a customer from a line onto its entry", () => {
    const branch = "11111111-1111-4111-8111-111111111111";
    const job = "22222222-2222-4222-8222-222222222222";
    const customer = "33333333-3333-4333-8333-333333333333";
    const checked = ledger.checkJournal([
      { accountCode: "5000", debit: "300", businessUnitId: branch, jobId: job, customerId: customer },
      { accountCode: "1000", credit: "300" },
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.entries[0]).toMatchObject({ businessUnitId: branch, jobId: job, customerId: customer });
    // A line that names nothing carries nothing, which is what "no branch" means.
    expect(checked.entries[1]).not.toHaveProperty("businessUnitId");
    expect(checked.entries[1]).not.toHaveProperty("jobId");
    expect(checked.entries[1]).not.toHaveProperty("customerId");
  });

  it("refuses an id that is not an id, against its own line, with the others still checked", () => {
    const checked = ledger.checkJournal([
      { accountCode: "5000", debit: "300", jobId: "1042" },
      { accountCode: "6500", debit: "5", businessUnitId: "nope", customerId: "also nope" },
      { accountCode: "1000", credit: "305" },
    ]);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((p) => [p.line, p.message])).toEqual([
      [1, "The job on this line is not one of yours."],
      [2, "The branch on this line is not one of yours."],
      [2, "The customer on this line is not one of yours."],
    ]);
  });

  it("puts the same branch, job and customer on the line that takes one back, so the two net to nothing there", () => {
    const branch = "11111111-1111-4111-8111-111111111111";
    const job = "22222222-2222-4222-8222-222222222222";
    const posting = ledger.reverseJournal({
      journalId: "j3", occurredAt: new Date(), memo: "Reverses journal 2",
      original: [
        { id: "e1", direction: "debit", accountCode: "5000", amount: m.money("300"), businessUnitId: branch, jobId: job, customerId: null },
        { id: "e2", direction: "credit", accountCode: "1000", amount: m.money("300"), businessUnitId: null, jobId: null, customerId: null },
      ],
    });
    expect(posting.entries[0]).toMatchObject({ direction: "credit", accountCode: "5000", businessUnitId: branch, jobId: job });
    expect(posting.entries[0]).not.toHaveProperty("customerId");
    expect(posting.entries[1]).not.toHaveProperty("businessUnitId");
  });
});
