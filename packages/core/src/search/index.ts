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

/** Nothing to search for: the box asks for two characters before it looks. */
export const MIN_LENGTH = 2;

export const isSearchable = (q: string | undefined | null): boolean => (q ?? "").trim().length >= MIN_LENGTH;
