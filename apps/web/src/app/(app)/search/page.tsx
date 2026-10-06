import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { search } from "@opentradesos/api/services";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * FIND ANYTHING
 *
 * A customer by name, email or phone, a job by its number, and the
 * company's own records by their name or any value. Each part is found by
 * its own list's service, so nothing appears here that its list would not
 * show this person.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const q = ((await searchParams).q ?? "").slice(0, 200);
  const found = await search.everything(ctx, { q });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title="Search" />
      <form action="/search" role="search" className="mt-4 flex gap-2">
        <label className="sr-only" htmlFor="search-page-q">Search for</label>
        <input id="search-page-q" type="search" name="q" defaultValue={q} autoFocus
               placeholder="A name, a phone number, a job number, a permit number"
               className="h-10 min-w-0 flex-1 rounded border border-steel-300 bg-canvas px-3 text-sm" />
        <button type="submit" className="h-10 rounded bg-ink-900 px-4 text-sm font-medium text-white">Search</button>
      </form>

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
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
