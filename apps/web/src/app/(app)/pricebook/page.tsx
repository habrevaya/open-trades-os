import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceBook } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
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
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireSetupUser();
  const { q } = await searchParams;
  const seesCost = can(user.actor, "pricebook.cost:read");

  const page = await priceBook.list(
    { actor: user.actor, db: getDb() },
    { limit: 100, includeInactive: false, ...(q ? { q } : {}) },
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Price book" count={page.data.length} />

      <form className="mt-4" action="/pricebook">
        <input
          type="search" name="q" defaultValue={q ?? ""}
          placeholder="Search by name or code"
          aria-label="Search the price book"
          className="h-10 w-full max-w-sm rounded border border-steel-300 px-3 text-sm"
        />
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
            <Th className="w-28">Code</Th><Th>Name</Th><Th>Kind</Th>
            <Th className="text-right">Price</Th>
            {seesCost ? <Th className="text-right">Cost</Th> : null}
          </>
        }>
          {page.data.map((item) => (
            <tr key={item.id} className="hover:bg-steel-100">
              <Td className="font-mono text-ink-700">{item.code}</Td>
              <Td className="font-medium">{item.name}</Td>
              <Td className="text-ink-700">{item.kind}</Td>
              <Td className="text-right"><Money value={item.price} /></Td>
              {seesCost ? <Td className="text-right"><Money value={item.cost ?? null} muted /></Td> : null}
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
