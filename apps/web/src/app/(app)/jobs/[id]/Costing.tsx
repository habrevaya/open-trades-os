import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

/** The two server actions behind "Not the same cost", handed in by the page so this component imports no server module. */
export interface NotTheSameActions {
  mark: (previous: FormState, form: FormData) => Promise<FormState>;
  unmark: (previous: FormState, form: FormData) => Promise<FormState>;
}

export interface CostingData {
  revenue: string;
  materialCost: string;
  labourCost: string;
  processingFees: string;
  /** Receipts the company agreed to pay back and per diem for days away, on this job. Absent from older callers. */
  expenseCost?: string;
  grossMargin: string;
  grossMarginPercent: number | null;
  /** At the company's own burden and overhead rates; equal to the gross margin until any are set. */
  labourBurden?: string;
  overhead?: string;
  /** The overhead part by part, when the company charges it as a mix. */
  overheadParts?: {
    perHour: string; perJob: string; revenueShare: string;
    materialShare?: string; perVisit?: string; perTruck?: string;
  };
  fullyLoadedMargin?: string;
  fullyLoadedMarginPercent?: number | null;
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
  /** Lines of an accountant's journal entries that name this job. */
  journalLines: {
    transactionId: string; journalNumber: number; accountCode: string; direction: string; amount: string;
    memo: string | null; countedIn: "revenue" | "material" | "fees" | null;
  }[];
  /** A cost journalled to the job that may also be on one of its lines, open and marked. */
  doubleCounts?: {
    ledgerEntryId: string; journalNumber: number; journalOn: string; journalMemo: string | null;
    jobLineId: string; lineName: string; lineOn: string; amount: string; reason: string;
    notTheSame: { id: string; note: string | null; markedAt: Date | string; markedBy: string | null } | null;
  }[];
}

/** Where a journal line shows up in the figures above, in the words an owner reads them in. */
const COUNTED_IN: Record<"revenue" | "material" | "fees", string> = {
  revenue: "in revenue",
  material: "in materials",
  fees: "in card fees",
};

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
/**
 * The overhead's parts under the total, only when there is more than one,
 * because "of which $36.00 by the hour" under a $36.00 total says nothing.
 */
function OverheadParts({ parts }: { parts: CostingData["overheadParts"] }) {
  if (!parts) return null;
  const shown = ([
    ["by the hour", parts.perHour], ["for the job", parts.perJob], ["of revenue", parts.revenueShare],
    ["of material cost", parts.materialShare ?? "0"], ["for the visits", parts.perVisit ?? "0"],
    ["for the trucks", parts.perTruck ?? "0"],
  ] as const).filter(([, value]) => Number(value) !== 0);
  if (shown.length < 2) return null;
  return (
    <span className="block text-xs text-ink-500" data-testid="overhead-parts">
      Overhead: {shown.map(([label, value], i) => (
        <span key={label}>{i > 0 ? ", " : ""}<Money value={value} /> {label}</span>
      ))}
    </span>
  );
}

/**
 * A COST THAT MAY BE COUNTED TWICE: a journal line and a job line with the
 * same amount and the same vendor or dates close. Said above the figures,
 * because the material cost below includes both. Nothing here changes a
 * figure; whoever posts journals can say a pair is two different costs.
 */
function DoubleCounts({ jobId, pairs, actions }: {
  jobId: string; pairs: NonNullable<CostingData["doubleCounts"]>; actions: NotTheSameActions | null;
}) {
  const canMark = actions !== null;
  if (pairs.length === 0) return null;
  const open = pairs.filter((p) => p.notTheSame === null);
  return (
    <div className="mt-3 rounded-md border border-amber-700 bg-amber-tint p-3 text-sm" data-testid="double-counts">
      <p className="font-medium text-ink-900">
        {open.length === 0
          ? "Checked: these look alike but are different costs."
          : open.length === 1
            ? "This cost may be counted twice."
            : `${open.length} costs may be counted twice.`}
      </p>
      {open.length > 0 ? (
        <p className="mt-1 max-w-prose text-ink-700">
          A cost journalled to this job matches a line on it. Both are in the materials figure. If they are the same
          bill, take one of them off. If they are two different costs, say so here. Neither figure changes.
        </p>
      ) : null}
      <ul className="mt-2 space-y-2" aria-label="Possible double counts">
        {pairs.map((pair) => (
          <li key={`${pair.ledgerEntryId}-${pair.jobLineId}`} className="border-t border-amber-700/30 pt-2 first:border-0 first:pt-0">
            <span className="block">
              <a href="/books" className="underline underline-offset-4">Journal {pair.journalNumber}</a>
              {pair.journalMemo ? `, ${pair.journalMemo}` : ""} and the line {pair.lineName}: <Money value={pair.amount} />
            </span>
            <span className="block text-xs text-ink-700">{pair.reason}</span>
            {pair.notTheSame ? (
              <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-700">
                <Chip tone="neutral">Not the same cost</Chip>
                {pair.notTheSame.markedBy ? `Marked by ${pair.notTheSame.markedBy}.` : "Marked."}
                {pair.notTheSame.note ? ` ${pair.notTheSame.note}` : ""}
                {actions ? (
                  <ActionForm action={actions.unmark} submit="Take back" tone="quiet" className="inline-flex"
                              hidden={{ jobId, markId: pair.notTheSame.id }} />
                ) : null}
              </span>
            ) : actions ? (
              <ActionForm action={actions.mark} submit="Not the same cost" tone="quiet" className="mt-1 flex flex-wrap items-end gap-2"
                          hidden={{ jobId, jobLineId: pair.jobLineId, ledgerEntryId: pair.ledgerEntryId }}>
                <TextField label="Why (optional)" name="note" placeholder="Two separate bills" />
              </ActionForm>
            ) : null}
          </li>
        ))}
      </ul>
      {!canMark && open.length > 0 ? (
        <p className="mt-2 text-xs text-ink-700">Whoever posts journals can mark these as different costs.</p>
      ) : null}
    </div>
  );
}

export function Costing({ data, jobId, notTheSame = null }: {
  data: CostingData; jobId?: string;
  /** Present for whoever posts journals, who can mark a possible double count as two different costs. */
  notTheSame?: NotTheSameActions | null;
}) {
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
      {jobId && data.doubleCounts ? <DoubleCounts jobId={jobId} pairs={data.doubleCounts} actions={notTheSame} /> : null}

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-steel-200 bg-canvas p-4 text-sm sm:grid-cols-3">
        <Figure label="Revenue"><Money value={data.revenue} /></Figure>
        <Figure label="Materials"><Money value={data.materialCost} /></Figure>
        <Figure label="Labour"><Money value={data.labourCost} /></Figure>
        <Figure label="Card fees"><Money value={data.processingFees} /></Figure>
        {data.expenseCost !== undefined && Number(data.expenseCost) !== 0 ? (
          <Figure label="Expenses and per diem"><Money value={data.expenseCost} /></Figure>
        ) : null}
        <Figure label="Gross margin">
          <span className={negative ? "text-red-600" : undefined}><Money value={data.grossMargin} /></span>
          {data.grossMarginPercent !== null && (
            <span className="ml-1 text-ink-500">({data.grossMarginPercent.toFixed(1)}%)</span>
          )}
        </Figure>
        {data.fullyLoadedMargin !== undefined && (Number(data.labourBurden ?? "0") !== 0 || Number(data.overhead ?? "0") !== 0) ? (
          <>
            <Figure label="Burden and overhead">
              <Money value={data.labourBurden ?? "0"} /> <span className="text-ink-500">and</span> <Money value={data.overhead ?? "0"} />
              <OverheadParts parts={data.overheadParts} />
            </Figure>
            <Figure label="Fully loaded margin">
              <span className={Number(data.fullyLoadedMargin) < 0 ? "text-red-600" : undefined}><Money value={data.fullyLoadedMargin} /></span>
              {data.fullyLoadedMarginPercent !== null && data.fullyLoadedMarginPercent !== undefined && (
                <span className="ml-1 text-ink-500">({data.fullyLoadedMarginPercent.toFixed(1)}%)</span>
              )}
            </Figure>
          </>
        ) : null}
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

      {data.journalLines.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">Booked to this job by journal</h3>
          <table className="mt-1 w-full text-sm" aria-label="Journal lines on this job">
            <tbody className="divide-y divide-steel-200">
              {data.journalLines.map((line, i) => (
                <tr key={`${line.transactionId}-${i}`}>
                  <td className="py-1.5 pr-3">
                    <a href="/books" className="underline underline-offset-4">Journal {line.journalNumber}</a>
                    <span className="ml-2 font-mono text-ink-500">{line.accountCode}</span>
                    {line.memo ? <span className="ml-2 text-ink-700">{line.memo}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-ink-500">
                    {line.direction === "debit" ? "Debit" : "Credit"},{" "}
                    {line.countedIn ? `counted ${COUNTED_IN[line.countedIn]}` : "not counted here"}
                  </td>
                  <td className="py-1.5 text-right"><Money value={line.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 max-w-prose text-xs text-ink-500">
            Labour is counted from the hours on the clock, so a journal line to a labour account is listed here and left out of the margin.
          </p>
        </div>
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
