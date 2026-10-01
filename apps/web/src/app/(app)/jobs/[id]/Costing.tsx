import { Chip, Money } from "@opentradesos/ui";

export interface CostingData {
  revenue: string;
  materialCost: string;
  labourCost: string;
  processingFees: string;
  grossMargin: string;
  grossMarginPercent: number | null;
  scheduledHours: string;
  actualHours: string;
  hoursOverPlan: string;
  settled: boolean;
  provisional: string[];
  caveats: { overhead: string; overtime: string; cost: string; fees: string };
  lines: {
    id: string; name: string; quantity: string; unitCost: string | null;
    extendedCost: string | null; billed: boolean; nonBillableReason: string | null;
  }[];
  labour: { technicianId: string | null; technicianName: string | null; hours: string; cost: string; unpricedHours: string }[];
}

/**
 * WHAT THIS JOB COST AGAINST WHAT IT BROUGHT IN
 *
 * The job page showed what was charged and never what it cost, so whether a
 * job made money was a question for the accountant at the end of the
 * quarter. Revenue and fees are the ledger's; material and labour are the
 * lines and the punches, which is where the statement takes them from.
 *
 * Provisional is said before the number, not under it: a job with a punch
 * still running reads as the best work in the company until it is not.
 */
export function Costing({ data }: { data: CostingData }) {
  const negative = Number(data.grossMargin) < 0;
  const over = Number(data.hoursOverPlan) > 0;
  return (
    <section aria-label="Job costing" className="mt-10">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold">Cost and margin</h2>
        {data.settled
          ? <Chip tone="neutral">Final</Chip>
          : <Chip tone="warning">Still moving</Chip>}
      </div>
      {!data.settled && data.provisional.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-700">
          {data.provisional.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-steel-200 bg-canvas p-4 text-sm sm:grid-cols-3">
        <Figure label="Revenue"><Money value={data.revenue} /></Figure>
        <Figure label="Materials"><Money value={data.materialCost} /></Figure>
        <Figure label="Labour"><Money value={data.labourCost} /></Figure>
        <Figure label="Card fees"><Money value={data.processingFees} /></Figure>
        <Figure label="Gross margin">
          <span className={negative ? "text-red-600" : undefined}><Money value={data.grossMargin} /></span>
          {data.grossMarginPercent !== null && (
            <span className="ml-1 text-ink-500">({data.grossMarginPercent.toFixed(1)}%)</span>
          )}
        </Figure>
        <Figure label="Hours, planned and actual">
          {Number(data.scheduledHours)} / {Number(data.actualHours)}
          {over && <span className="ml-1 text-red-600">({Number(data.hoursOverPlan)} over)</span>}
        </Figure>
      </dl>

      {data.lines.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.08em] text-ink-500">
              <th className="py-1 font-medium">Line</th>
              <th className="py-1 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-steel-200">
            {data.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-1.5">
                  {Number(line.quantity) !== 1 && `${Number(line.quantity)} × `}{line.name}
                  {!line.billed && (
                    <span className="ml-2 text-xs text-ink-500">
                      {line.nonBillableReason ? `not billed: ${line.nonBillableReason}` : "not billed yet"}
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  {line.extendedCost === null
                    ? <span className="text-ink-500">No cost recorded</span>
                    : <Money value={line.extendedCost} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.labour.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {data.labour.map((row, i) => (
            <li key={row.technicianId ?? i} className="flex justify-between gap-4">
              <span>{row.technicianName ?? "Labour"}, {Number(row.hours)} h
                {Number(row.unpricedHours) > 0 && (
                  <span className="ml-1 text-xs text-ink-500">({Number(row.unpricedHours)} h with no rate)</span>
                )}
              </span>
              <Money value={row.cost} />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 max-w-prose text-xs text-ink-500">
        {data.caveats.overhead} {data.caveats.overtime}{" "}
        <a href="/reports/built-in/job-costing" className="underline underline-offset-4">Every job, side by side</a>
      </p>
    </section>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{children}</dd>
    </div>
  );
}
