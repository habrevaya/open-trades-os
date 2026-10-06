import { notFound } from "next/navigation";
import { Money } from "@opentradesos/ui";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { kpis, ConflictError, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader, Table, Th, Td } from "@/components/Table";
import { formatDay } from "@/lib/dates";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * THE RECORDS BEHIND ONE HALF OF A KPI
 *
 * "$186,000 over 300 jobs" on the scorecard is two links, and this is where
 * each goes: the three hundred jobs, each with what it added, and the total
 * at the bottom, which is the half that was clicked because it is the same
 * query. A refusal (somebody who sees only their own work, or revenue without
 * the financial reports permission) is said in a sentence rather than shown as
 * a shorter list that would not add up.
 */
export default async function KpiRecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSetupUser();
  if (!can(user.actor, "report:read")) notFound();
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const key = one("key") ?? "";
  const half = one("half") === "denominator" ? "denominator" : "numerator";
  const from = one("from") ?? "";
  const to = one("to") ?? "";
  if (!key || !DATE.test(from) || !DATE.test(to)) notFound();
  const tz = user.organizationTimezone;
  const back = `/reports/scorecard?${new URLSearchParams({ from, to }).toString()}`;

  let drilled: kpis.KpiDrill | null = null;
  let refusal: string | null = null;
  try {
    drilled = await kpis.drill({ actor: user.actor, db: getDb() }, { key, half, from, to });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (!(error instanceof ConflictError)) throw error;
    refusal = error.message;
  }

  const money = drilled?.format === "money" && half === "numerator";
  const shown = (value: string) => (money ? <Money value={value} /> : NUMBER.format(Number(value)));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={back}>Back to the trade scorecard</Crumb>
      <div className="mt-2">
        <PageHeader
          title={drilled ? `${drilled.halfLabel[0]!.toUpperCase()}${drilled.halfLabel.slice(1)}` : "The records behind this figure"}
          count={drilled?.count}
        />
      </div>
      {drilled ? (
        <p className="mt-2 text-sm text-ink-700">
          Behind {drilled.label.toLowerCase()}, {formatDay(from, tz)} to {formatDay(to, tz)}.{" "}
          <span className="text-ink-500">{drilled.definition}</span>
        </p>
      ) : null}

      {refusal ? (
        <p role="alert" className="mt-6 rounded-md border border-steel-200 bg-canvas p-4 text-sm text-ink-700">{refusal}</p>
      ) : drilled && drilled.records.length === 0 ? (
        <Empty title="Nothing in this window">This half is empty for these dates, which is why the figure reads as it does.</Empty>
      ) : drilled ? (
        <>
          <Table head={<><Th>Record</Th><Th>Day</Th><Th className="text-right">Adds</Th></>}>
            {drilled.records.map((record) => (
              <tr key={`${record.kind}:${record.id}`}>
                <Td><a href={record.href} className="hover:underline">{record.label}</a></Td>
                <Td className="text-ink-700">{record.onDay ? formatDay(record.onDay, tz) : ""}</Td>
                <Td className="text-right font-mono tabular-nums">{shown(record.value)}</Td>
              </tr>
            ))}
            <tr>
              <Td className="font-medium">Total</Td>
              <Td />
              <Td className="text-right font-mono font-medium tabular-nums">{shown(drilled.total)}</Td>
            </tr>
          </Table>
          {drilled.truncated ? (
            <p className="mt-2 text-sm text-ink-500">
              The first thousand of {drilled.count} are listed. The total covers every one of them.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
