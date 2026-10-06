import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { taxRates } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay } from "@/lib/dates";

export const dynamic = "force-dynamic";

const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * BOOKS → SALES TAX COLLECTED
 *
 * What each rate collected over a period, for filing: the sales it was
 * charged on and the tax, net of voids and credit notes in the period. Read
 * from the ledger (`GET /v1/reports/sales-tax`), so it agrees with sales tax
 * payable on the trial balance; anything else that moved the account (a
 * payment to the state, journalled) is shown under the rows so the two add up.
 */
export default async function SalesTaxReportPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  if (!can(user.actor, "report.financial:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Sales tax collected" />
        <Empty title="Not shown to your role">This is a financial report, and needs the View financial reports permission.</Empty>
      </div>
    );
  }
  const query = await searchParams;
  const today = time.dateIn(new Date(), user.organizationTimezone);
  const firstOfMonth = `${today.slice(0, 8)}01`;
  const from = isDay(query["from"]) ? query["from"] : firstOfMonth;
  const to = isDay(query["to"]) && query["to"] >= from ? query["to"] : today;
  const report = await taxRates.report({ actor: user.actor, db: getDb() }, { from, to });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Sales tax collected" />
      <p className="mt-2 max-w-3xl text-sm text-ink-700">
        By rate, from {formatDay(from, user.organizationTimezone)} to {formatDay(to, user.organizationTimezone)}: the sales
        each rate was charged on and the tax it collected, less anything voided or credited back in the period. Read from
        your books, so it matches sales tax owed on the ledger.
      </p>
      <form className="mt-4 flex flex-wrap items-end gap-3" method="get">
        <label className="text-sm">
          <span className="block font-medium text-ink-700">From</span>
          <input type="date" name="from" defaultValue={from} className="mt-1 h-9 rounded border border-steel-300 px-2" />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-ink-700">To</span>
          <input type="date" name="to" defaultValue={to} className="mt-1 h-9 rounded border border-steel-300 px-2" />
        </label>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100">
          Show
        </button>
      </form>

      {report.rows.length === 0 ? (
        <div className="mt-6"><Empty title="No sales tax in this period">Nothing charged sales tax between these days.</Empty></div>
      ) : (
        <div className="mt-6">
          <Table label="Sales tax collected by rate" head={
            <><Th>Rate</Th><Th className="text-right">Percent</Th><Th className="text-right">Taxable sales</Th><Th className="text-right">Tax collected</Th></>
          }>
            {report.rows.map((row) => (
              <tr key={`${row.taxRateId ?? "none"}-${row.rate ?? "none"}`}>
                <Td className="font-medium">{row.name}</Td>
                <Td className="text-right font-mono tabular-nums">{row.percent ? `${row.percent}%` : ""}</Td>
                <Td className="text-right"><Money value={row.taxableSales} /></Td>
                <Td className="text-right"><Money value={row.taxCollected} /></Td>
              </tr>
            ))}
            <tr>
              <Td className="font-semibold">Collected</Td><Td>{""}</Td><Td>{""}</Td>
              <Td className="text-right font-semibold"><Money value={report.totalCollected} /></Td>
            </tr>
          </Table>
        </div>
      )}
      <dl className="mt-4 grid max-w-md grid-cols-2 gap-y-1 text-sm">
        <dt className="text-ink-700">Other entries on sales tax owed</dt>
        <dd className="text-right"><Money value={report.otherMovements} /></dd>
        <dt className="text-ink-700">Change in sales tax owed</dt>
        <dd className="text-right font-medium"><Money value={report.accountMovement} /></dd>
      </dl>
    </div>
  );
}
