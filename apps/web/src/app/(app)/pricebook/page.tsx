import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceBook, priceCategories } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { PRICE_BOOK_KIND, label } from "@/lib/labels";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE PRICE BOOK
 *
 * Cost is a separate permission from price, and the service already strips it
 * on the way out. The column is rendered only when the caller holds
 * `pricebook.cost:read`, so a technician who opens this in a customer's
 * kitchen sees what things cost the customer and not what they cost the
 * company. That is the single most requested guarantee in this industry.
 */
export default async function PriceBookPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; retired?: string }>;
}) {
  const user = await requireSetupUser();
  const { q, category, retired } = await searchParams;
  const seesCost = can(user.actor, "pricebook.cost:read");
  const ctx = { actor: user.actor, db: getDb() };

  const page = await priceBook.list(ctx, {
    limit: 100, includeInactive: retired === "1", ...(q ? { q } : {}), ...(category ? { categoryId: category } : {}),
  });
  /** The shelf each item is on, which a technician browses by. */
  const shelves = await priceCategories.list(ctx);
  const shelfName = new Map(shelves.map((c) => [c.id, c.name]));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Price book"
        count={page.data.length}
        action={can(user.actor, "pricebook:write")
          ? <a href="/pricebook/items/new" className="text-sm text-ink-700 hover:underline">New item</a>
          : undefined}
      />

      <form className="mt-4" action="/pricebook">
        <input
          type="search" name="q" defaultValue={q ?? ""}
          placeholder="Search by name or code"
          aria-label="Search the price book"
          className="h-10 w-full max-w-sm rounded border border-steel-300 px-3 text-sm"
        />
        {shelves.length > 0 && (
          <select name="category" defaultValue={category ?? ""} aria-label="Category"
                  className="ml-2 h-10 rounded border border-steel-300 bg-canvas px-3 text-sm">
            <option value="">Every category</option>
            {shelves.map((c) => <option key={c.id} value={c.id}>{`${"\u00a0\u00a0".repeat(c.depth)}${c.name}`}</option>)}
          </select>
        )}
        <label className="ml-3 inline-flex items-center gap-1.5 text-sm text-ink-700">
          <input type="checkbox" name="retired" value="1" defaultChecked={retired === "1"} /> Include retired
        </label>
        <button type="submit" className="ml-2 inline-flex h-10 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100">
          Show
        </button>
      </form>

      {page.data.length === 0 ? (
        <Empty title={q ? `Nothing matches "${q}"` : "The price book is empty"}>
          {q
            ? "Try the part code."
            : "Pick a trade in settings and the starter book for it is installed, then edit from there."}
        </Empty>
      ) : (
        <Table head={
          <>
            <Th className="w-28">Code</Th><Th>Name</Th><Th>Category</Th><Th>Kind</Th>
            <Th className="text-right">Price</Th>
            {seesCost ? <Th className="text-right">Cost</Th> : null}
          </>
        }>
          {page.data.map((item) => (
            <tr key={item.id} className="hover:bg-steel-100">
              <Td className="font-mono text-ink-700">{item.code}</Td>
              <Td className="font-medium">
                <a href={`/pricebook/items/${item.id}`} className="hover:underline">{item.name}</a>
                {item.active ? null : <span className="ml-2 text-xs font-normal text-ink-500">retired</span>}
              </Td>
              <Td className="text-ink-700">{item.categoryId ? shelfName.get(item.categoryId) ?? "" : ""}</Td>
              <Td className="text-ink-700">{label(PRICE_BOOK_KIND, item.kind)}</Td>
              <Td className="text-right"><Money value={item.price} /></Td>
              {seesCost ? <Td className="text-right"><Money value={item.cost ?? null} muted /></Td> : null}
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
