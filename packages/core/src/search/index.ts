/**
 * WHAT SOMEBODY TYPED INTO THE SEARCH BOX, READ ONCE
 *
 * The office types what is in front of them: "smith furnace", "1042",
 * "#1042", "oak st", a serial off a sticker. Every list that takes `q` reads
 * it through this, so "words" means the same thing on the job list, the
 * invoice list and the search box, and a list that matched differently from
 * the box would show "see all" leading to a page that disagrees with the five
 * it came from.
 *
 * WORDS, EACH OF WHICH HAS TO BE SOMEWHERE. "smith furnace" finds the
 * furnace job for the Smiths whichever order the words come in: each word
 * has to appear in one of the columns a list searches, as a piece of a word
 * ("furn" finds "Furnace"), ignoring case. That is a trigram match, backed
 * by a pg_trgm index on each column, and it is the same match the customer
 * list has always made, now made per word.
 *
 * A NUMBER IS ALSO A NUMBER. "1042" or "#1042" is a job's, an invoice's or
 * an estimate's number as people say it out loud, and is matched exactly
 * there as well as as a word, because invoice 1042 and a customer at 1042
 * Oak St are both what somebody typing it might mean.
 *
 * A WORD IS NEVER A PATTERN. `%` and `_` are what LIKE reads as "anything",
 * so typing `%` would match every row. They are escaped here, once, rather
 * than at each list that would otherwise forget.
 *
 * A TYPO IS FORGIVEN, BELOW WHAT WAS TYPED. "furnice" is what somebody types
 * with a customer on the phone, and finding nothing sends them to a slower
 * way round. So the search box, after the exact matches, also offers rows
 * where each word is either there or one letter off a word that is there
 * (two letters off for a word of eight or more): a letter wrong, missing or
 * extra, which is what a typo is. Close matches come after every exact one
 * and are marked as close, so a person never mistakes a guess for what they
 * typed.
 *
 * Only words of `CLOSE_MIN_LENGTH` letters or more, and only words made of
 * letters: three letters are one letter off half the dictionary ("oak" and
 * "oat"), and a number one digit off is a different invoice, a different
 * house and a different phone, never a typo worth guessing at.
 *
 * Letters, not sounds or meanings: the distance counts letters changed, so
 * "jonson" finds "Johnson" and "fone" does not find "phone".
 */

/** More words than this narrow nothing a person meant and cost a join each. */
export const MAX_WORDS = 6;

/** A job, invoice or estimate number fits in Postgres's integer. */
const MAX_NUMBER = 2_147_483_647;

export interface SearchTerms {
  /** Each word, lower case, in the order typed, each at most once. */
  words: string[];
  /** The whole query as a document number, when it is one. */
  number: number | null;
}

export function searchTerms(q: string | undefined | null): SearchTerms {
  const text = (q ?? "").trim();
  const digits = /^#?\s*(\d{1,10})$/.exec(text)?.[1];
  const number = digits !== undefined && Number(digits) >= 1 && Number(digits) <= MAX_NUMBER ? Number(digits) : null;
  const words: string[] = [];
  for (const raw of text.toLowerCase().split(/\s+/)) {
    /** A `#` before a number is how people write one, not something to find. */
    const word = raw.replace(/^#+/, "");
    if (word === "" || words.includes(word)) continue;
    words.push(word);
    if (words.length === MAX_WORDS) break;
  }
  return { words, number };
}

/** A word as a LIKE pattern that matches it anywhere, with LIKE's own characters taken literally. */
export function containsPattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The shortest word a close match is looked for: shorter words are matched as typed, or not at all. */
export const CLOSE_MIN_LENGTH = 4;

/** From this many letters a word may be two letters off rather than one. */
export const TWO_OFF_FROM = 8;

/** How many letters a word may be off and still be close: one, or two for a long word. */
export const closeEdits = (word: string): number => ([...word].length >= TWO_OFF_FROM ? 2 : 1);

/**
 * The trigram similarity a written word has to reach before its letters are
 * counted at all. It only narrows what the index hands over, and is low
 * enough that a word one letter off always reaches it ("tank" and "tonk" are
 * 0.25 by pg_trgm's strict word similarity); the letters decide.
 */
export const CLOSE_SIMILARITY = 0.25;

/** The words of a query a close match is looked for, in the order typed: four letters or more, letters only. */
export const closeWords = (terms: SearchTerms): string[] =>
  terms.words.filter((word) => [...word].length >= CLOSE_MIN_LENGTH && /^\p{L}+$/u.test(word));

/** Nothing to search for: the box asks for two characters before it looks. */
export const MIN_LENGTH = 2;

export const isSearchable = (q: string | undefined | null): boolean => (q ?? "").trim().length >= MIN_LENGTH;
