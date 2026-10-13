import { and, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { search } from "@opentradesos/core";

/**
 * WHAT A LIST'S `q` MATCHES
 *
 * Every word typed has to be in one of the columns the list searches, as a
 * piece of a word and ignoring case (`core/search` says why words and not a
 * phrase). Each comparison is an ILIKE a pg_trgm index answers, the indexes
 * being in `packages/db/sql/after.sql` beside the customer name's.
 *
 * A number typed on its own also matches the document's own number exactly,
 * which an index on the number answers. Either is enough: "1042" is invoice
 * 1042 and the customer at 1042 Oak St.
 *
 * Nothing here decides WHICH rows a person may see. This is ANDed with the
 * list's scope filter by the list itself, so a match is only ever a match
 * among the rows that list would show.
 */
export function textFilter(
  q: string | undefined,
  columns: readonly (AnyColumn | SQL)[],
  numberColumn?: AnyColumn | SQL,
): SQL | undefined {
  if (q === undefined || q.trim() === "") return undefined;
  const terms = search.searchTerms(q);
  const words = terms.words.length > 0
    ? and(...terms.words.map((word) => or(...columns.map((column) => sql`${column} ilike ${search.containsPattern(word)}`))))
    : undefined;
  const byNumber = numberColumn !== undefined && terms.number !== null ? sql`${numberColumn} = ${terms.number}` : undefined;
  if (words === undefined && byNumber === undefined) return undefined;
  return or(byNumber, words);
}
