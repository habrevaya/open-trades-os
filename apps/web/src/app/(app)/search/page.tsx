import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { search } from "@opentradesos/api/services";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/** The groups with no list screen of their own, whose "See all" is this page showing them alone. */
const ALONE: Record<string, { label: string; key: search.GroupKey }> = {
  addresses: { label: "Addresses", key: "addresses" },
  units: { label: "Equipment", key: "units" },
  notes: { label: "Customer notes", key: "notes" },
  people: { label: "People", key: "people" },
};

/**
 * FIND ANYTHING
 *
 * Customers, jobs, invoices, estimates, addresses, units, customer notes, the
 * price book, people and the company's own records, five of each, each found
 * by its own list's service, so nothing appears here that its list would not
 * show this person. "See all" opens the list filtered by the same words; the
 * groups with no list are this page with that group alone.
 *
 * A hit found by a word a letter off what was typed comes after the exact
 * ones and says so, "Close to what you typed", so nobody takes a guess for
 * the thing they asked for.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; in?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;
  const q = (params.q ?? "").slice(0, 200);
  const alone = params.in ? ALONE[params.in] : undefined;
  const found = await search.everything(ctx, { q, ...(alone ? { in: alone.key } : {}) });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title={alone ? `Search: ${alone.label.toLowerCase()}` : "Search"} />
      <form action="/search" role="search" className="mt-4 flex gap-2">
        <label className="sr-only" htmlFor="search-page-q">Search for</label>
        <input id="search-page-q" type="search" name="q" defaultValue={q} autoFocus
               placeholder="A name, a street, a number, a serial, or what the work was"
               className="h-10 min-w-0 flex-1 rounded border border-steel-300 bg-canvas px-3 text-sm" />
        {alone ? <input type="hidden" name="in" value={alone.key} /> : null}
        <button type="submit" className="h-10 rounded bg-ink-900 px-4 text-sm font-medium text-white">Search</button>
      </form>
      {alone ? (
        <p className="mt-2 text-sm">
          <a href={`/search?${new URLSearchParams({ q })}`} className="underline underline-offset-4">Search everything</a>
        </p>
      ) : null}

      {q.trim().length < 2 ? (
        <p className="mt-6 text-sm text-ink-500">Type at least two letters or a job number.</p>
      ) : found.groups.length === 0 ? (
        <Empty title="Nothing found">Nothing you can open matches &quot;{q}&quot;.</Empty>
      ) : (
        found.groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="mt-6">
            <h2 className="text-base font-semibold">{group.label}</h2>
            <ul className="mt-2 divide-y divide-steel-200 rounded-md border border-steel-200 text-sm">
              {group.hits.map((hit) => (
                <li key={hit.id} className="px-3 py-2">
                  <a href={hit.href} className="font-medium underline underline-offset-4">{hit.title}</a>
                  {hit.detail ? <span className="ml-2 text-ink-500">{hit.detail}</span> : null}
                  {hit.close ? <span className="ml-2 text-xs text-ink-500">Close to what you typed</span> : null}
                </li>
              ))}
            </ul>
            {group.more && group.seeAll ? (
              <p className="mt-1 text-sm">
                <a href={group.seeAll} className="underline underline-offset-4">
                  See all {group.label.toLowerCase()} matching &quot;{q.trim()}&quot;
                </a>
              </p>
            ) : group.more ? (
              <p className="mt-1 text-sm text-ink-500">Showing the first {group.hits.length}. Add a word to narrow it.</p>
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}
