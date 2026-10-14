/**
 * PAGES OF A LONG LIST OF RECORDS
 *
 * The records behind a number used to stop at a thousand and say so, which
 * left everything past the first thousand out of reach except by narrowing the
 * dates. Now the list goes on a thousand to a page, and this is the way along
 * it: which records these are out of how many, and the page before and after.
 *
 * Links rather than buttons, with the page in the address, so a page works
 * with JavaScript off, survives being sent, and the back button walks back
 * through the pages the way it came. Said in words as well as numbers,
 * because "Page 2 of 3" alone does not say whether the total under the list is
 * this page's or every page's: it is every page's, and the line says so.
 */
const COUNT = new Intl.NumberFormat("en-US");

export function Pager({ page, pages, perPage, count, noun, href }: {
  page: number;
  pages: number;
  perPage: number;
  /** Every record, across every page. */
  count: number;
  /** What the records are, plural: "jobs", "records". */
  noun: string;
  /** The address of another page of the same list. */
  href: (page: number) => string;
}) {
  if (pages <= 1) return null;
  const first = (page - 1) * perPage + 1;
  const last = Math.min(page * perPage, count);
  return (
    <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span className="text-ink-700">
        {COUNT.format(first)} to {COUNT.format(last)} of {COUNT.format(count)} {noun}. The totals are for all{" "}
        {COUNT.format(count)}.
      </span>
      <span className="flex items-center gap-3">
        {page > 1
          ? <a href={href(page - 1)} className="text-ink-700 underline underline-offset-4">Previous page</a>
          : <span className="text-ink-500">Previous page</span>}
        <span className="font-medium text-ink-900">Page {page} of {pages}</span>
        {page < pages
          ? <a href={href(page + 1)} className="text-ink-700 underline underline-offset-4">Next page</a>
          : <span className="text-ink-500">Next page</span>}
      </span>
    </nav>
  );
}
