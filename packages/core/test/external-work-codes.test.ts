import { describe, it, expect } from "vitest";
import { externalWork as ew } from "../src/index.js";

const mapping = (over: Partial<ew.CodeMapping> & { code: string }): ew.CodeMapping => ({
  id: `m-${over.code}`,
  description: null,
  jobTypeId: null,
  jobTypeName: null,
  jobTypeActive: true,
  priceBookItemId: null,
  itemName: null,
  itemSold: true,
  quantity: "1",
  ...over,
});

const PLUMBING = { jobTypeId: "jt-plumb", jobTypeName: "Plumbing" };
const ELECTRICAL = { jobTypeId: "jt-elec", jobTypeName: "Electrical" };

describe("a client's codes read against their list", () => {
  it("proposes the job type and a line per mapped item, the order's quantity times the mapping's", () => {
    const proposal = ew.propose(
      [
        { code: "plb-07 ", quantity: "2", description: "Leaking tap" },
        { code: "PLB-09", quantity: null, description: null },
      ],
      [
        mapping({ code: "PLB-07", ...PLUMBING, priceBookItemId: "item-washer", itemName: "Tap washer", quantity: "1.5" }),
        mapping({ code: "PLB-09", ...PLUMBING, priceBookItemId: "item-call", itemName: "Service call" }),
      ],
      "Harbor Retail",
    );
    expect(proposal.jobTypeId).toBe("jt-plumb");
    expect(proposal.jobTypeNote).toBeNull();
    expect(proposal.lines).toEqual([
      { code: "plb-07 ", mappingId: "m-PLB-07", priceBookItemId: "item-washer", name: "Tap washer", quantity: "3" },
      { code: "PLB-09", mappingId: "m-PLB-09", priceBookItemId: "item-call", name: "Service call", quantity: "1" },
    ]);
    expect(proposal.unmapped).toEqual([]);
    expect(proposal.codes[0]!.words).toBe("plb-07  (Leaking tap) becomes a Plumbing job and 3 of Tap washer.");
  });

  it("names a code nobody mapped, in words, and adds nothing for it", () => {
    const proposal = ew.propose(
      [{ code: "HVAC-3", quantity: null, description: "No heat" }],
      [mapping({ code: "PLB-07", ...PLUMBING })],
      "Harbor Retail",
    );
    expect(proposal.lines).toEqual([]);
    expect(proposal.unmapped).toEqual([
      "HVAC-3 (No heat) is not on Harbor Retail's list of codes. Nothing is added for it; add its work by hand, or map the code first.",
    ]);
    expect(proposal.codes[0]!.unmapped).toBe(true);
    expect(proposal.jobTypeId).toBeNull();
    expect(proposal.jobTypeNote).toBe("None of the codes says what kind of work this is. Choose it, or leave it blank.");
  });

  it("proposes no job type when the codes disagree, and says which codes said what", () => {
    const proposal = ew.propose(
      [{ code: "PLB-07", quantity: null, description: null }, { code: "ELE-12", quantity: null, description: null }],
      [mapping({ code: "PLB-07", ...PLUMBING }), mapping({ code: "ELE-12", ...ELECTRICAL })],
      "Harbor Retail",
    );
    expect(proposal.jobTypeId).toBeNull();
    expect(proposal.jobTypeNote).toBe(
      "The codes point to more than one kind of work: Plumbing (PLB-07), Electrical (ELE-12). Choose which this job is.",
    );
  });

  it("does not use an item no longer sold or a job type switched off, and says so", () => {
    const proposal = ew.propose(
      [{ code: "PLB-07", quantity: null, description: null }],
      [mapping({ code: "PLB-07", ...PLUMBING, jobTypeActive: false, priceBookItemId: "old", itemName: "Old washer", itemSold: false })],
      "Harbor Retail",
    );
    expect(proposal.lines).toEqual([]);
    expect(proposal.jobTypeId).toBeNull();
    expect(proposal.unmapped).toEqual([
      "PLB-07 is mapped, but its job type, Plumbing, is switched off, and its item, Old washer, is no longer sold. Nothing is added for it; add its work by hand, or change the mapping.",
    ]);
  });

  it("refuses a list with a code twice, a code mapped to nothing, or a quantity that is not one", () => {
    expect(ew.checkMappings([
      { code: "PLB-07", jobTypeId: "a", priceBookItemId: null, quantity: "1" },
      { code: " plb-07", jobTypeId: "b", priceBookItemId: null, quantity: "1" },
    ])).toBe("The code plb-07 is in the list twice. Keep one row for it.");
    expect(ew.checkMappings([{ code: "X", jobTypeId: null, priceBookItemId: null, quantity: "1" }]))
      .toBe("The code X is mapped to nothing. Choose a kind of work, an item, or both.");
    expect(ew.checkMappings([{ code: "X", jobTypeId: "a", priceBookItemId: null, quantity: "0" }]))
      .toContain("more than nothing");
    expect(ew.checkMappings([{ code: "", jobTypeId: "a", priceBookItemId: null, quantity: "1" }]))
      .toBe("Every row needs the client's code.");
    expect(ew.checkMappings([{ code: "X", jobTypeId: "a", priceBookItemId: "i", quantity: "2.5" }])).toBeNull();
  });
});
