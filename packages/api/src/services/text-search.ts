import { and, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { search } from "@opentradesos/core";
import type { Database } from "@opentradesos/db";

/**
 * WHAT A LIST'S `q` MATCHES
 *
 * Every word typed has to be in one of the places the list searches, as a
 * piece of a word and ignoring case (`core/search` says why words and not a
 * phrase). Each comparison is an ILIKE a pg_trgm index answers, the indexes
 * being in `packages/db/sql/after.sql` beside the customer name's.
 *
 * A place is a column on the row, or a condition on rows that hang off it
 * (`Searched`): a job's visits' notes, an invoice's lines, an estimate's
 * options. Each word is looked for in every place separately, so "smith
 * furnace" finds the Smiths' job when "furnace" is only in a technician's
 * note on it, the same as when it is in the summary.
 *
 * A number typed on its own also matches the document's own number exactly,
 * which an index on the number answers. Either is enough: "1042" is invoice
 * 1042 and the customer at 1042 Oak St.
 *
 * Looking close (`TextOptions.close`) a word of four letters or more also
 * matches a word a letter off it, or two for a long word ("furnice" finds
 * "Furnace"), narrowed first by the same trigram indexes. Only the search box asks, and
 * only after its exact look came up short (`services/search.ts`).
 *
 * Nothing here decides WHICH rows a person may see. This is ANDed with the
 * list's scope filter by the list itself, so a match is only ever a match
 * among the rows that list would show. A place that hangs off the row is
 * only ever read for a row the list already shows, and its rows are the
 * company's own under row level security, so a word in another company's
 * notes cannot make a row match.
 */

/**
 * Somewhere a word may be that is not a column of the row: given how a word
 * is matched against a piece of text, a condition that holds when it is
 * there. Always an `exists` correlated to the row being listed, so it widens
 * what a row matches and never which rows are listed.
 */
export type Searched = (match: (text: SQL) => SQL) => SQL;

export interface TextOptions {
  /**
   * Close as well as exact: each word may also be a letter or two off one that
   * is written (`core/search`, `closeEdits`), for the search box's second
   * look after its exact matches. Its threshold is set for the transaction by
   * `closeMatching`, which a list asked for this has to call first.
   */
  close?: boolean | undefined;
}

/**
 * Set pg_trgm's strict word similarity threshold for this transaction, which
 * is what the `%>>` narrowing a close match compares with. Local to the transaction, so
 * it never leaks to the next statement on a pooled connection.
 */
export async function closeMatching(tx: Database): Promise<void> {
  await tx.execute(sql`select set_config('pg_trgm.strict_word_similarity_threshold', ${String(search.CLOSE_SIMILARITY)}, true)`);
}

export function textFilter(
  q: string | undefined,
  places: readonly (AnyColumn | SQL | Searched)[],
  numberColumn?: AnyColumn | SQL,
  options: TextOptions = {},
): SQL | undefined {
  if (q === undefined || q.trim() === "") return undefined;
  const terms = search.searchTerms(q);
  const close = new Set(options.close ? search.closeWords(terms) : []);
  /**
   * A word is in a piece of text when the text contains it, or, looking
   * close, when the text has a word a letter or two off it
   * (`app.has_close_word`, in `packages/db/sql/after.sql`). `text %>> word`
   * goes first because it is the form a pg_trgm index on the text answers, so
   * the letters are only counted on the rows the index hands over.
   */
  const matcher = (word: string) => {
    const pattern = search.containsPattern(word);
    const edits = search.closeEdits(word);
    return (text: SQL | AnyColumn): SQL => (close.has(word)
      ? sql`(${text} ilike ${pattern} or (${text} %>> ${word}::text and app.has_close_word(${text}, ${word}::text, ${edits}::int)))`
      : sql`${text} ilike ${pattern}`);
  };
  const somewhere = (word: string) => {
    const match = matcher(word);
    return or(...places.map((place) => (typeof place === "function" ? place(match) : match(place))));
  };
  const words = terms.words.length > 0 ? and(...terms.words.map(somewhere)) : undefined;
  const byNumber = numberColumn !== undefined && terms.number !== null ? sql`${numberColumn} = ${terms.number}` : undefined;
  if (words === undefined && byNumber === undefined) return undefined;
  return or(byNumber, words);
}
