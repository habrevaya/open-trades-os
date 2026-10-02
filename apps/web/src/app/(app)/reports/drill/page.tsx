import { notFound } from "next/navigation";
import { Money } from "@opentradesos/ui";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports, ConflictError } from "@opentradesos/api/services";
import { can, type reporting } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader, Table, Th, Td } from "@/components/Table";
import { definitionFrom, type Params } from "@/lib/report-params";
import { pinsFrom, safeBack } from "@/lib/drill";
import { formatDay } from "@/lib/dates";
import { enumText } from "@/lib/labels";

export const dynamic = "force-dynamic";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** A month bucket comes back as `2026-09`, which nobody reads as September. */
function formatMonth(value: string): string {
  const date = new Date(`${value}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

/** A pinned or filtered value, in the words the report showed it in. */
function said(type: string, value: string | null, sortPrefix?: boolean): string {
  if (value === null || value === "") return "Not set";
  if (type === "status") return enumText(value);
  if (type === "date" && /^\d{4}-\d{2}$/.test(value)) return formatMonth(value);
  return sortPrefix ? value.replace(/^\d+\s+/, "") : value;
}

function Value({
  type, value, timezone,
}: { type: string; value: string | number | null | undefined; timezone: string }) {
  if (value === null || value === undefined || value === "") return <span className="text-ink-500">Not set</span>;
  if (type === "money") return <Money value={String(value)} />;
  if (type === "number") return <span className="font-mono tabular-nums">{NUMBER.format(Number(value))}</span>;
  if (type === "date") return <span>{formatDay(String(value), timezone)}</span>;
  if (type === "status") return <span>{enumText(String(value))}</span>;
  return <span>{String(value)}</span>;
}

/**
 * THE RECORDS BEHIND A NUMBER
 *
 * Every number on a report links here, carrying the report's own definition
 * and the row's values. The records are read through the same conditions the
 * number was, so the totals at the bottom are the number that was clicked, and
 * each record shows what it added to it.
 *
 * `report:read` and nothing else, here: the drill itself is refused by the
 * service exactly where the report would be, in the report's words, so a
 * dispatcher handed a link to the receivables drill gets the sentence that
 * says which permission it needs rather than a list of invoices.
 */
export default async function DrillPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireSetupUser();
  const params = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "report:read")) notFound();

  const definition = definitionFrom(params);
  if (!definition) notFound();
  const match = pinsFrom(params);
  const back = safeBack(params.back);
  const title = (Array.isArray(params.title) ? params.title[0] : params.title)?.trim() || "the report";

  let result: reports.DrillResult | null = null;
  let refusal: string | null = null;
  try {
    result = await reports.drill(ctx, { definition, match });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    refusal = error.message;
  }

  const dataset = reports.CATALOGUE.find((d) => d.key === definition.dataset);
  const measures = result?.columns.filter((c) => c.role === "measure") ?? [];
  const described = describeDefinition(definition, dataset, user.organizationTimezone);
  const plural = result ? result.plural[0]!.toUpperCase() + result.plural.slice(1) : "Records";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href={back}>Back to {title}</Crumb>
      <div className="mt-2">
        <PageHeader title={`${plural} behind ${title}`} count={result?.count} />
      </div>

      {result && result.pinned.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="What this row is">
          {result.pinned.map((pin) => (
            <li key={pin.key} className="rounded border border-steel-200 bg-canvas px-2 py-1">
              <span className="text-ink-500">{pin.label}: </span>
              <span className="font-medium text-ink-900">{said(pin.type, pin.value, pin.sortPrefix)}</span>
            </li>
          ))}
        </ul>
      )}
      {/*
        The filters and dates that applied, said out loud. A list of invoices
        with no dates on it reads as "all of them", and the person comparing it
        to their own count will be counting a different thing.
      */}
      {described.length > 0 && (
        <p className="mt-2 text-sm text-ink-700">{described.join(". ")}.</p>
      )}

      {refusal ? (
        <p role="alert" className="mt-6 rounded-md border border-red-600 bg-red-tint p-4 text-sm text-red-600">
          {refusal}
        </p>
      ) : result && result.rows.length === 0 ? (
        <Empty title={`No ${result.plural} behind this`}>
          Something may have changed since the report was drawn. Go back and run it again.
        </Empty>
      ) : result ? (
        <>
          <Table
            label={`${plural} behind ${title}`}
            head={
              <>
                <Th>{result.noun[0]!.toUpperCase() + result.noun.slice(1)}</Th>
                {result.columns.map((c) => (
                  <Th key={c.key} className={c.role === "measure" ? "text-right" : undefined}>{c.label}</Th>
                ))}
              </>
            }
          >
            {result.rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <a href={row.href} className="font-medium hover:underline">{row.label}</a>
                </Td>
                {result!.columns.map((c) => (
                  <Td key={c.key} className={c.role === "measure" ? "text-right" : undefined}>
                    {row.links[c.key] ? (
                      <a href={row.links[c.key]} className="hover:underline">
                        <Value type={c.type} value={row.values[c.key]} timezone={user.organizationTimezone} />
                      </a>
                    ) : (
                      <Value type={c.type} value={row.values[c.key]} timezone={user.organizationTimezone} />
                    )}
                  </Td>
                ))}
              </tr>
            ))}
            {/*
              The totals, as the last row of the table rather than a sentence
              under it, so each one sits under the column it adds up. They are
              over EVERY record behind the number, which is the number that was
              clicked; when the list is cut short they still are, and the line
              below says so.
            */}
            {measures.length > 0 && (
              <tr className="bg-steel-100 font-medium" aria-label="Total">
                <Td>Total</Td>
                {result.columns.map((c) => (
                  <Td key={c.key} className={c.role === "measure" ? "text-right" : undefined}>
                    {c.role === "measure"
                      ? <Value type={c.type === "money" ? "money" : "number"} value={result!.totals[c.key] ?? null} timezone={user.organizationTimezone} />
                      : null}
                  </Td>
                ))}
              </tr>
            )}
          </Table>
          {result.truncated && (
            <p className="mt-3 text-sm text-red-600">
              This is the first {result.rows.length} of {result.count} {result.plural}. The totals are for all
              {" "}{result.count}. Narrow the dates on the report to see every one.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

/** The report's filters and dates, in words. */
function describeDefinition(
  definition: reporting.ReportDefinition,
  dataset: reporting.Dataset | undefined,
  timezone: string,
): string[] {
  const out: string[] = [];
  for (const filter of definition.filters ?? []) {
    const dimension = dataset?.dimensions.find((d) => d.key === filter.dimension);
    const name = dimension?.label ?? filter.dimension;
    const values = (Array.isArray(filter.value) ? filter.value : [filter.value])
      .map((v) => said(dimension?.type ?? "text", v, dimension?.sortPrefix));
    const verb = filter.op === "neq" ? "is not" : filter.op === "in" ? "is one of" : "is";
    out.push(`${name} ${verb} ${values.join(", ")}`);
  }
  if (definition.from && definition.to) {
    out.push(`From ${formatDay(definition.from, timezone)} up to ${formatDay(definition.to, timezone)}`);
  } else if (definition.from) {
    out.push(`From ${formatDay(definition.from, timezone)}`);
  } else if (definition.to) {
    out.push(`Before ${formatDay(definition.to, timezone)}`);
  }
  return out;
}
