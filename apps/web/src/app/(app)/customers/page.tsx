import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, customerTags, customFields, branches } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Phone } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { BranchFilter, chosenBranch } from "@/components/BranchFilter";
import { CustomFieldFilter } from "@/components/CustomFieldFilter";
import { fieldFrom, withFieldFilter } from "@/lib/field-filter";

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
  searchParams: Promise<{
    q?: string; tag?: string | string[]; match?: string; branch?: string;
    field?: string | string[]; value?: string | string[];
  }>;
}) {
  const user = await requireSetupUser();
  const { q, tag, match, branch: branchParam, field, value } = await searchParams;
  /**
   * The tags to filter by, from the address bar, so a filtered list is a link
   * somebody can send. More than one narrows to customers carrying ANY of
   * them unless the address says `match=all`.
   */
  const chosen = (Array.isArray(tag) ? tag : tag ? [tag] : []).filter((t) => t.trim() !== "").slice(0, 20);
  const every = match === "all";
  const ctx = { actor: user.actor, db: getDb() };
  const options = await branches.options(ctx);
  const branch = chosenBranch(options, branchParam);
  const declared = await customFields.formFields(ctx, "customer");
  /**
   * The custom fields to look for, as many as were chosen, every one of
   * which has to hold. A field the company no longer declares, or a value
   * its type cannot hold, comes back from the service as a sentence, shown
   * above the list rather than as an error page, with the list unfiltered by
   * its fields.
   */
  const { pairs, keep: fieldKeep, byField } = fieldFrom({ field, value });

  const { page, refusal: fieldRefusal } = await withFieldFilter((withField) => customers.list(ctx, {
    limit: 100, includeInactive: false, ...(q ? { q } : {}),
    ...(chosen.length > 0 ? { tags: chosen, tagMatch: every ? "all" as const : "any" as const } : {}),
    ...(branch ? { businessUnitId: branch } : {}),
    ...(withField ? byField : {}),
  }));
  const inUse = await customerTags.list(ctx);
  const filteringFields = pairs.length > 0 && !fieldRefusal;

  /** The address with one tag added or taken away, keeping the rest of the filter. */
  const withTags = (next: string[], all = every) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    for (const t of next) params.append("tag", t);
    if (all && next.length > 1) params.set("match", "all");
    if (branch) params.set("branch", branch);
    for (const pair of pairs) { params.append("field", pair.key); params.append("value", pair.value); }
    const query = params.toString();
    return query ? `/customers?${query}` : "/customers";
  };

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
        {chosen.map((t) => <input key={t} type="hidden" name="tag" value={t} />)}
        {every ? <input type="hidden" name="match" value="all" /> : null}
        {branch ? <input type="hidden" name="branch" value={branch} /> : null}
        {pairs.flatMap((pair, index) => [
          <input key={`field-${index}`} type="hidden" name="field" value={pair.key} />,
          <input key={`value-${index}`} type="hidden" name="value" value={pair.value} />,
        ])}
      </form>

      <BranchFilter
        options={options} action="/customers" current={branch}
        keep={{ q, tag: chosen, match: every ? "all" : undefined, ...fieldKeep }}
      />

      <CustomFieldFilter
        action="/customers" declared={declared} pairs={pairs} refusal={fieldRefusal} noun="customers"
        keep={{ q, tag: chosen, match: every && chosen.length > 1 ? "all" : undefined, branch }}
      />

      {inUse.length > 0 && (
        <nav aria-label="Filter by tag" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-500">Tags:</span>
          {inUse.slice(0, 30).map(({ tag: t, customers: n }) => {
            const on = chosen.some((c) => c.toLowerCase() === t.toLowerCase());
            return (
              <a key={t}
                 href={withTags(on ? chosen.filter((c) => c.toLowerCase() !== t.toLowerCase()) : [...chosen, t])}
                 aria-pressed={on}
                 className={`inline-flex h-7 items-center rounded px-2 ${on
                   ? "bg-ink-900 text-white"
                   : "border border-steel-300 text-ink-700 hover:bg-steel-100"}`}>
                {t} <span className={on ? "ml-1 text-steel-200" : "ml-1 text-ink-500"}>{n}</span>
              </a>
            );
          })}
          {chosen.length > 1 && (
            <a href={withTags(chosen, !every)} className="text-ink-700 underline underline-offset-4">
              {every ? "Show customers with any of these" : "Show customers with all of these"}
            </a>
          )}
          {chosen.length > 0 && (
            <a href={withTags([])} className="text-ink-700 underline underline-offset-4">Clear tags</a>
          )}
          <a href="/customers/tags" className="ml-auto text-ink-700 underline underline-offset-4">Manage tags</a>
        </nav>
      )}

      {page.data.length === 0 ? (
        <Empty title={q ? `Nothing matches "${q}"` : chosen.length > 0 ? "Nobody carries those tags"
          : filteringFields ? "Nobody matches those fields"
          : branch ? "That branch has not worked for anybody yet" : "No customers yet"}>
          {q || chosen.length > 0 || filteringFields || branch
            ? "Try a phone number, or part of a name, or clear the filters."
            : "Everything else starts here: a job needs a customer, and an invoice needs a job."}
        </Empty>
      ) : (
        <Table head={<><Th>Name</Th><Th>Type</Th><Th>Phone</Th><Th>Email</Th><Th>Tags</Th></>}>
          {page.data.map((customer) => (
            <tr key={customer.id} className="hover:bg-steel-100">
              <Td>
                <a href={`/customers/${customer.id}`} className="font-medium text-ink-900 hover:underline">
                  {customer.name}
                </a>
              </Td>
              <Td className="text-ink-700">{customer.type === "commercial" ? "Commercial" : "Residential"}</Td>
              {/*
                Formatted and tabular, so a column of numbers lines up and a
                person reading one aloud does not have to parse E.164.
              */}
              <Td className="text-ink-700"><Phone value={customer.phone} /></Td>
              <Td className="text-ink-700">{customer.email ?? ""}</Td>
              <Td className="text-ink-700">{customer.tags.join(", ")}</Td>
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
