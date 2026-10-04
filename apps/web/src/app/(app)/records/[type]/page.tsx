import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects, NotFoundError } from "@opentradesos/api/services";
import { can, PermissionError } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { customFieldText } from "@/components/CustomFieldInputs";
import { CustomFieldFilter } from "@/components/CustomFieldFilter";
import { fieldFrom, withFieldFilter } from "@/lib/field-filter";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * ONE KIND OF RECORD, AS A LIST
 *
 * Drawn from its definition: a column for its name, for what it points at,
 * and for its first few fields. Searched across the name and every value,
 * because somebody looking for the permit on Elm Street types the street;
 * filtered by one field the way the customer list is; downloaded as a CSV
 * that loads back in.
 */
export default async function RecordListPage({
  params, searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ q?: string; field?: string | string[]; value?: string | string[] }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { type } = await params;
  const query = await searchParams;
  if (!can(user.actor, "record:read")) notFound();
  const kind = await customObjects.getKind(ctx, { key: type }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof PermissionError) notFound();
    throw error;
  });
  const q = query.q?.trim() || undefined;
  const { pairs, byField } = fieldFrom(query);
  const { page, refusal } = await withFieldFilter((withField) => customObjects.listRecords(ctx, {
    type, limit: 200, ...(q ? { q } : {}), ...(withField ? byField : {}),
  }));
  const shown = kind.fields.slice(0, 4);
  const exportHref = `/records/${type}/export`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader
        title={kind.pluralLabel} count={page.data.length}
        action={
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <a href={exportHref} className="underline underline-offset-4">Download as CSV</a>
            {kind.canWrite ? <a href={`/records/${type}/import`} className="underline underline-offset-4">Load a CSV</a> : null}
            {kind.canWrite ? (
              <a href={`/records/${type}/new`}
                 className="inline-flex h-9 items-center rounded bg-ink-900 px-3 font-medium text-white">
                Add a {kind.label.toLowerCase()}
              </a>
            ) : null}
          </div>
        }
      />
      {kind.description ? <p className="mt-1 max-w-prose text-sm text-ink-500">{kind.description}</p> : null}

      <form className="mt-4" action={`/records/${type}`}>
        <input type="search" name="q" defaultValue={q ?? ""} aria-label={`Search ${kind.pluralLabel.toLowerCase()}`}
               placeholder={`Search ${kind.titleLabel.toLowerCase()} or any value`}
               className="h-10 w-full max-w-sm rounded border border-steel-300 px-3 text-sm" />
        {pairs.flatMap((pair, index) => [
          <input key={`field-${index}`} type="hidden" name="field" value={pair.key} />,
          <input key={`value-${index}`} type="hidden" name="value" value={pair.value} />,
        ])}
      </form>
      <CustomFieldFilter action={`/records/${type}`} declared={kind.fields} keep={{ q }} pairs={pairs}
                         refusal={refusal} noun={kind.pluralLabel.toLowerCase()} />

      {page.data.length === 0 ? (
        <Empty title={q || pairs.length > 0 ? `No ${kind.pluralLabel.toLowerCase()} match` : `No ${kind.pluralLabel.toLowerCase()} yet`}>
          {kind.canWrite ? `Add one here, or from the job or customer it is for.` : null}
        </Empty>
      ) : (
        <Table label={kind.pluralLabel} head={<>
          <Th>{kind.titleLabel}</Th>
          {shown.map((f) => <Th key={f.key}>{f.label}</Th>)}
          {kind.links.includes("customer") ? <Th>Customer</Th> : null}
          {kind.links.includes("job") ? <Th>Job</Th> : null}
          <Th>Added</Th>
        </>}>
          {page.data.map((record) => (
            <tr key={record.id} className="hover:bg-steel-100">
              <Td><a href={`/records/${type}/${record.id}`} className="font-medium hover:underline">{record.title}</a></Td>
              {shown.map((f) => <Td key={f.key} className="text-ink-700">{customFieldText(f, record.customFields[f.key])}</Td>)}
              {kind.links.includes("customer") ? (
                <Td>{record.customer ? <a href={`/customers/${record.customer.id}`} className="hover:underline">{record.customer.name}</a> : null}</Td>
              ) : null}
              {kind.links.includes("job") ? (
                <Td>{record.job ? <a href={`/jobs/${record.job.id}`} className="hover:underline">{record.job.name}</a> : null}</Td>
              ) : null}
              <Td className="tabular-nums text-ink-700">{formatIn(record.createdAt, user.organizationTimezone, { month: "short", day: "numeric", year: "numeric" })}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
