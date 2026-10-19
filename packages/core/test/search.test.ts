import { describe, it, expect } from "vitest";
import {
  searchTerms, containsPattern, isSearchable, closeWords, closeEdits, MAX_WORDS, CLOSE_MIN_LENGTH, CLOSE_SIMILARITY,
} from "../src/search/index.js";

/**
 * WHAT THE SEARCH BOX READS FROM WHAT WAS TYPED
 *
 * Every list that takes `q` reads it through these, so a mistake here is a
 * mistake on every list at once: `%` matching every row, a number never found
 * because it was typed with a `#`, or a word lost because it came second.
 */
describe("search terms", () => {
  it("splits into words, lower case, each once, in the order typed", () => {
    expect(searchTerms("  Smith   FURNACE smith ")).toEqual({ words: ["smith", "furnace"], number: null });
  });

  it("reads a document number with or without its #", () => {
    expect(searchTerms("1042")).toEqual({ words: ["1042"], number: 1042 });
    expect(searchTerms("#1042")).toEqual({ words: ["1042"], number: 1042 });
    expect(searchTerms("# 1042").number).toBe(1042);
    expect(searchTerms("1042 oak").number).toBeNull();
  });

  it("does not read a number too large for a document as one", () => {
    expect(searchTerms("99999999999").number).toBeNull();
    expect(searchTerms("0").number).toBeNull();
  });

  it("keeps at most six words", () => {
    expect(searchTerms("a b c d e f g h").words).toHaveLength(MAX_WORDS);
  });

  it("takes LIKE's own characters literally, so % does not match every row", () => {
    expect(containsPattern("50%")).toBe("%50\\%%");
    expect(containsPattern("a_b")).toBe("%a\\_b%");
    expect(containsPattern("c:\\x")).toBe("%c:\\\\x%");
  });

  it("asks for two characters before it looks", () => {
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable(" ab ")).toBe(true);
    expect(isSearchable(undefined)).toBe(false);
  });
});

describe("close to what was typed", () => {
  it("forgives words of four letters or more, letters only, and matches the rest only as typed", () => {
    expect(closeWords(searchTerms("oak furnice"))).toEqual(["furnice"]);
    expect(closeWords(searchTerms("ab 12"))).toEqual([]);
    expect(closeWords(searchTerms("1042 zx-200 thermstat"))).toEqual(["thermstat"]);
    expect(closeWords(searchTerms("Señor"))).toEqual(["señor"]);
    expect(CLOSE_MIN_LENGTH).toBe(4);
  });

  it("allows one letter off, and two in a long word", () => {
    expect(closeEdits("pipe")).toBe(1);
    expect(closeEdits("furnice")).toBe(1);
    expect(closeEdits("thermstat")).toBe(2);
  });

  it("narrows by trigrams loosely enough that one letter off always gets through", () => {
    expect(CLOSE_SIMILARITY).toBeLessThanOrEqual(0.25);
    expect(CLOSE_SIMILARITY).toBeGreaterThan(0);
  });
});
