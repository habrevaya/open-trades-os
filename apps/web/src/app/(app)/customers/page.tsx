import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, customerTags, customFields, branches, ConflictError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Phone } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { BranchFilter, chosenBranch } from "@/components/BranchFilter";

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
    q?: string; tag?: string | string[]; match?: string; branch?: string; field?: string; value?: string;
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
   * A custom field and the value to look for, both or neither. A field the
   * company no longer declares, or a value its type cannot hold, comes back
   * from the service as a sentence, shown above the list rather than as an
   * error page, with the list unfiltered by it.
   */
  const fieldKey = field?.trim() || undefined;
  const fieldValue = value?.trim() || undefined;
  const byField = fieldKey && fieldValue ? { fieldKey, fieldValue } : {};

  const listed = async (withField: boolean) => customers.list(ctx, {
    limit: 100, includeInactive: false, ...(q ? { q } : {}),
    ...(chosen.length > 0 ? { tags: chosen, tagMatch: every ? "all" as const : "any" as const } : {}),
    ...(branch ? { businessUnitId: branch } : {}),
    ...(withField ? byField : {}),
  });
  let fieldRefusal: string | null = null;
  let page;
  try {
    page = await listed(true);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    fieldRefusal = error.message;
    page = await listed(false);
  }
  const inUse = await customerTags.list(ctx);
  const filteringField = fieldKey && fieldValue && !fieldRefusal
    ? declared.find((d) => d.key === fieldKey) : undefined;

  /** The address with one tag added or taken away, keeping the rest of the filter. */
  const withTags = (next: string[], all = every) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    for (const t of next) params.append("tag", t);
    if (all && next.length > 1) params.set("match", "all");
    if (branch) params.set("branch", branch);
    if (fieldKey && fieldValue) { params.set("field", fieldKey); params.set("value", fieldValue); }
    const query = params.toString();
    return query ? `/customers?${query}` : "/customers";
  };
  /** Everything but the custom field, for "clear" on it. */
  const withoutField = () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    for (const t of chosen) params.append("tag", t);
    if (every && chosen.length > 1) params.set("match", "all");
    if (branch) params.set("branch", branch);
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
        {fieldKey && fieldValue ? <><input type="hidden" name="field" value={fieldKey} /><input type="hidden" name="value" value={fieldValue} /></> : null}
      </form>

      <BranchFilter
        options={options} action="/customers" current={branch}
        keep={{ q, tag: chosen, match: every ? "all" : undefined, field: fieldKey, value: fieldValue }}
      />

      {declared.length > 0 && (
        /*
          The fields the company declared on customers, and a value to look
          for. The suggestions are each choice field's own options and yes or
          no, so the common case is picked rather than typed; free text and
          numbers are typed. One form for every type, so it works with
          JavaScript off.
        */
        <form action="/customers" method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm" aria-label="Filter by a custom field">
          {q ? <input type="hidden" name="q" value={q} /> : null}
          {chosen.map((t) => <input key={t} type="hidden" name="tag" value={t} />)}
          {every ? <input type="hidden" name="match" value="all" /> : null}
          {branch ? <input type="hidden" name="branch" value={branch} /> : null}
          <label className="flex flex-col gap-1">
            <span className="text-ink-700">Field</span>
            <select name="field" defaultValue={fieldKey ?? ""} className="h-9 rounded border border-steel-300 px-2">
              <option value="">Choose a field</option>
              {declared.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-ink-700">Is</span>
            <input
              name="value" defaultValue={fieldValue ?? ""} list="custom-field-values"
              className="h-9 w-48 rounded border border-steel-300 px-2"
            />
          </label>
          <datalist id="custom-field-values">
            {[...new Set(declared.flatMap((d) => (d.dataType === "boolean" ? ["yes", "no"] : d.options)))]
              .map((o) => <option key={o} value={o} />)}
          </datalist>
          <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 font-medium hover:bg-steel-100">
            Filter
          </button>
          {fieldKey && fieldValue ? (
            <a href={withoutField()} className="pb-2 text-ink-700 underline underline-offset-4">Clear the field</a>
          ) : null}
        </form>
      )}
      {fieldRefusal ? (
        <p role="alert" className="mt-3 rounded border border-red-600 bg-red-tint px-3 py-2 text-sm text-red-600">
          {fieldRefusal} The list below is not filtered by it.
        </p>
      ) : filteringField ? (
        <p className="mt-3 text-sm text-ink-700">
          Showing customers whose {filteringField.label} {filteringField.dataType === "text" ? "contains" : "is"} {fieldValue}.
        </p>
      ) : null}

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
          : filteringField ? `Nobody's ${filteringField.label} is ${fieldValue}`
          : branch ? "That branch has not worked for anybody yet" : "No customers yet"}>
          {q || chosen.length > 0 || filteringField || branch
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
