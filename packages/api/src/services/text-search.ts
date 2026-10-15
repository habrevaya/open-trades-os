import { and, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { search } from "@opentradesos/core";

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
 * Nothing here decides WHICH rows a person may see. This is ANDed with the
 * list's scope filter by the list itself, so a match is only ever a match
 * among the rows that list would show. A place that hangs off the row is
 * only ever read for a row the list already shows, and its rows are the
 * company's own under row level security, so a word in another company's
 * notes cannot make a row match.
 */

/**
 * Somewhere a word may be that is not a column of the row: given the word as
 * a LIKE pattern, a condition that holds when it is there. Always an
 * `exists` correlated to the row being listed, so it widens what a row
 * matches and never which rows are listed.
 */
export type Searched = (pattern: string) => SQL;

export function textFilter(
  q: string | undefined,
  places: readonly (AnyColumn | SQL | Searched)[],
  numberColumn?: AnyColumn | SQL,
): SQL | undefined {
  if (q === undefined || q.trim() === "") return undefined;
  const terms = search.searchTerms(q);
  const somewhere = (pattern: string) => or(...places.map((place) =>
    typeof place === "function" ? place(pattern) : sql`${place} ilike ${pattern}`));
  const words = terms.words.length > 0
    ? and(...terms.words.map((word) => somewhere(search.containsPattern(word))))
    : undefined;
  const byNumber = numberColumn !== undefined && terms.number !== null ? sql`${numberColumn} = ${terms.number}` : undefined;
  if (words === undefined && byNumber === undefined) return undefined;
  return or(byNumber, words);
}
