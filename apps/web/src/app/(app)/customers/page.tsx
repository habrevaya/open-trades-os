import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE CUSTOMER BOOK
 *
 * Scoped, not merely filtered. A technician holding `customer:read` sees the
 * customers they have actually been sent to and not the book, and that
 * narrowing happens in the service rather than here: a page that fetched
 * everything and hid rows in the markup has already put the whole list on the
 * wire.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireSetupUser();
  const { q } = await searchParams;

  const page = await customers.list(
    { actor: user.actor, db: getDb() },
    { limit: 100, includeInactive: false, ...(q ? { q } : {}) },
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Customers"
        count={page.data.length}
        action={can(user.actor, "customer:write") ? (
          <a href="/customers/new"
             className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white transition-colors hover:bg-ink-700">
            Add a customer
          </a>
        ) : null}
      />

      <form className="mt-4" action="/customers">
        <input
          type="search" name="q" defaultValue={q ?? ""}
          placeholder="Search name, email or phone"
          aria-label="Search customers"
          className="h-10 w-full max-w-sm rounded border border-steel-300 px-3 text-sm"
        />
      </form>

      {page.data.length === 0 ? (
        <Empty title={q ? `Nothing matches "${q}"` : "No customers yet"}>
          {q
            ? "Try a phone number, or part of a name."
            : "Everything else starts here: a job needs a customer, and an invoice needs a job."}
        </Empty>
      ) : (
        <Table head={<><Th>Name</Th><Th>Type</Th><Th>Phone</Th><Th>Email</Th></>}>
          {page.data.map((customer) => (
            <tr key={customer.id} className="hover:bg-steel-100">
              <Td>
                <a href={`/customers/${customer.id}`} className="font-medium text-ink-900 hover:underline">
                  {customer.name}
                </a>
              </Td>
              <Td className="text-ink-700">{customer.type === "commercial" ? "Commercial" : "Residential"}</Td>
              {/* Tabular numerals, so a column of phone numbers lines up. */}
              <Td className="font-mono text-ink-700">{customer.phone ?? ""}</Td>
              <Td className="text-ink-700">{customer.email ?? ""}</Td>
            </tr>
          ))}
        </Table>
      )}

      {page.hasMore ? (
        <p className="mt-4 text-sm text-ink-500">
          Showing the first {page.data.length}. Narrow it with a search.
        </p>
      ) : null}
    </div>
  );
}
