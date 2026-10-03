import { describe, it, expect } from "vitest";
import {
  normalizeTag, uniqueTags, addTags, removeTags, replaceTags, hasAnyTag, hasEveryTag,
  orderedPair, tagKey, MAX_TAG_LENGTH,
} from "../src/tags/index.js";

describe("a tag as somebody typed it", () => {
  it("trims the ends and collapses the middle, and keeps the case", () => {
    expect(normalizeTag("  Storm   list ")).toEqual({ ok: true, tag: "Storm list" });
    expect(normalizeTag("VIP")).toEqual({ ok: true, tag: "VIP" });
  });

  it("refuses an empty tag and a tag that is a sentence", () => {
    expect(normalizeTag("   ").ok).toBe(false);
    expect(normalizeTag("x".repeat(MAX_TAG_LENGTH + 1)).ok).toBe(false);
    expect(normalizeTag("x".repeat(MAX_TAG_LENGTH)).ok).toBe(true);
  });

  it("compares without case or stray spaces", () => {
    expect(tagKey(" Vip ")).toBe(tagKey("VIP"));
    expect(tagKey("storm  list")).toBe("storm list");
  });
});

describe("a customer's list", () => {
  it("holds each tag once, first spelling kept", () => {
    // An import that wrote "VIP" and "vip" leaves one tag, as the company first wrote it.
    expect(uniqueTags(["VIP", "vip", " landlord", "Landlord ", ""])).toEqual(["VIP", "landlord"]);
  });

  it("adds at the end and ignores a tag it already has in another case", () => {
    expect(addTags(["VIP"], ["vip", "Pays late"])).toEqual(["VIP", "Pays late"]);
  });

  it("removes without case", () => {
    expect(removeTags(["VIP", "Landlord"], ["vip"])).toEqual(["Landlord"]);
  });
});

describe("renaming and merging", () => {
  it("renames in place rather than moving the tag to the end", () => {
    expect(replaceTags(["Landlord", "vip", "Pays late"], ["vip"], "VIP"))
      .toEqual(["Landlord", "VIP", "Pays late"]);
  });

  it("merges several spellings into one tag, once, where the first stood", () => {
    expect(replaceTags(["V.I.P.", "Landlord", "vip"], ["vip", "V.I.P."], "VIP"))
      .toEqual(["VIP", "Landlord"]);
  });

  it("does not double a tag the customer already had under the new name", () => {
    expect(replaceTags(["VIP", "gold"], ["gold"], "vip")).toEqual(["VIP"]);
  });

  it("leaves a list without the old tag alone", () => {
    expect(replaceTags(["Landlord"], ["vip"], "VIP")).toEqual(["Landlord"]);
  });
});

describe("matching", () => {
  it("any and every, without case", () => {
    expect(hasAnyTag(["VIP", "Landlord"], ["landlord", "storm"])).toBe(true);
    expect(hasEveryTag(["VIP", "Landlord"], ["landlord", "storm"])).toBe(false);
    expect(hasEveryTag(["VIP", "Landlord"], ["landlord", "vip"])).toBe(true);
  });
});

describe("a duplicate decision", () => {
  it("is one pair whichever side it was made from", () => {
    const a = "0b4f1d2e-0000-4000-8000-000000000001";
    const b = "9c1a2b3c-0000-4000-8000-000000000002";
    expect(orderedPair(a, b)).toEqual([a, b]);
    expect(orderedPair(b, a)).toEqual([a, b]);
  });
});
