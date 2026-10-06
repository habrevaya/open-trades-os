import type { jobBilling } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, Select } from "@/components/ActionForm";
import { Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { billThisJob, coverageFromUnit, setJobContract } from "./actions";

type Plan = Awaited<ReturnType<typeof jobBilling.preview>>;
type Clocks = Awaited<ReturnType<typeof jobBilling.clocks>>;

const STANDING: Record<Clocks["clocks"][number]["standing"], { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  met: { label: "Met", tone: "success" },
  met_late: { label: "Met late", tone: "warning" },
  waived: { label: "Waived", tone: "neutral" },
  cancelled: { label: "No longer owed", tone: "neutral" },
  due: { label: "Running", tone: "info" },
  overdue: { label: "Past due", tone: "danger" },
};

const BASIS_SENTENCE: Record<Plan["basis"], string> = {
  single: "One payer.",
  coverage: "Split by coverage: the third party pays the covered work less the deductible, the customer pays the rest.",
  shares: "Split by shares: each payer named with a share pays it, and whoever is billed pays what is left.",
  absorbed: "Part of this is covered and billed to nobody: it shows on the customer's invoice at nothing.",
};

/**
 * THE CONTRACT A JOB RUNS UNDER, AND ITS CLOCKS
 *
 * Shown on the job because the clocks are about this job: whether somebody
 * was booked in time, whether they arrived in time, how long is left to
 * invoice. A job with no contract named still runs under the contract of
 * whoever pays, and says so.
 */
export function ContractAndDeadlines({
  jobId, clocks, options, writes, timezone,
}: {
  jobId: string;
  clocks: Clocks;
  options: { id: string; label: string }[];
  writes: boolean;
  timezone: string;
}) {
  return (
    <section aria-label="Contract and deadlines">
      <h2 className="mt-10 text-base font-semibold">Contract and deadlines</h2>
      <p className="mt-2 text-sm text-ink-700">
        {clocks.contract
          ? <>Runs under <a href={`/contracts/${clocks.contract.id}`} className="underline">{clocks.contract.name}</a>
            {clocks.named ? "." : ", the contract of whoever pays."}</>
          : "No contract applies, so your price book prices it and no clocks run."}
      </p>
      {writes && options.length > 0 && (
        <ActionForm action={setJobContract} submit="Save" hidden={{ jobId }} tone="quiet" done="Saved."
                    className="mt-2 flex flex-wrap items-end gap-3">
          <Select label="Contract" name="contractId" defaultValue={clocks.named ? clocks.contract?.id ?? "" : ""}
                  options={[{ value: "", label: "Whoever pays, if they have one" }, ...options.map((o) => ({ value: o.id, label: o.label }))]} />
        </ActionForm>
      )}
      {clocks.clocks.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {clocks.clocks.map((clock) => (
            <li key={clock.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{clock.label}</span>
              <span className="text-ink-700">{formatIn(clock.dueAt, timezone)}</span>
              <Chip tone={STANDING[clock.standing].tone}>{STANDING[clock.standing].label}</Chip>
              {clock.satisfiedAt && <span className="text-xs text-ink-500">{formatIn(clock.satisfiedAt, timezone)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Reading the coverage from the unit's warranty dates, when the job names a unit. */
export function CoverageFromUnit({ jobId }: { jobId: string }) {
  return (
    <ActionForm action={coverageFromUnit} submit="Read it from the unit's warranty" hidden={{ jobId }} tone="quiet"
                className="mt-3 flex flex-wrap items-center gap-3" />
  );
}

/**
 * HOW THIS JOB WOULD BE BILLED, AND TO WHOM
 *
 * Every unbilled line, priced by whoever pays for it, with who priced it on
 * the line, then who pays what. What is written when somebody presses the
 * button is exactly this, so the screen is the preview rather than a guess.
 * The problems are the decisions that have to be made first, in words.
 */
export function BillingPlanView({ jobId, plan, canBill, typedTax, taxRate, lineRates }: {
  jobId: string; plan: Plan; canBill: boolean;
  /** The sales tax percentage as typed, shown back in the box. */
  typedTax: string;
  /** Each line's own rate as chosen on the preview, `line:<id>=<rate id>`. */
  lineRates: string[];
  /** The rate it became, or null when nothing usable was typed. */
  taxRate: string | null;
}) {
  const taxable = plan.lines.some((line) => line.taxable);
  const askedFor = new Map(lineRates.map((pair) => [pair.slice(0, pair.lastIndexOf("=")), pair]));
  const byKey = new Map(plan.lines.map((line) => [line.key, line]));
  const nothing = plan.lines.length === 0;
  return (
    <section aria-label="Billing">
      <h2 className="mt-10 text-base font-semibold">Billing</h2>
      {nothing ? (
        <p className="mt-2 text-sm text-ink-500">Nothing on this job is still to bill.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink-700">{BASIS_SENTENCE[plan.basis]}</p>
          <Table label="Priced work" head={<>
            <Th>Work</Th><Th>Priced by</Th><Th>Sales tax</Th><Th className="text-right">Qty</Th><Th className="text-right">Unit</Th><Th className="text-right">Amount</Th>
          </>}>
            {plan.lines.map((line) => (
              <tr key={line.key}>
                <Td>
                  <span className="font-medium">{line.name}</span>
                  {line.note && <p className="mt-0.5 text-xs text-ink-500">{line.note}</p>}
                </Td>
                <Td>
                  {line.authorityLabel}
                  {line.outOfScope && <> <Chip tone="warning">Not on their card</Chip></>}
                </Td>
                <Td className="text-sm text-ink-700">{!line.taxable ? "Not taxed" : line.taxLabel ?? "None"}</Td>
                <Td className="text-right font-mono tabular-nums">{Number(line.quantity)}</Td>
                <Td className="text-right"><Money value={line.unitPrice} /></Td>
                <Td className="text-right"><Money value={line.amount} /></Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-right text-sm font-medium">Priced at <Money value={plan.pricedTotal} /></p>

          {taxable && (
            <form method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm">
              <p className="w-full text-ink-700">Sales tax: {plan.tax.worked} Each taxable line can be charged its own rate.</p>
              {plan.lines.filter((line) => line.taxable).map((line) => (
                <label key={line.key} className="flex flex-col gap-1">
                  <span className="text-ink-700">Rate for {line.name}</span>
                  <select name="lineRate" defaultValue={askedFor.get(line.key) ?? ""}
                          className="h-8 rounded border border-steel-300 px-2">
                    <option value="">As worked out</option>
                    {plan.tax.choices.map((c) => <option key={c.id} value={`${line.key}=${c.id}`}>{c.label}</option>)}
                    <option value={`${line.key}=none`}>No sales tax</option>
                  </select>
                </label>
              ))}
              <label className="flex flex-col gap-1">
                <span className="text-ink-700">Or one rate for every taxable line, per cent</span>
                <input name="taxRate" inputMode="decimal" defaultValue={typedTax} placeholder="8.25"
                       className="h-8 w-28 rounded border border-steel-300 px-2" />
              </label>
              <button type="submit" className="h-8 rounded border border-steel-300 px-3 font-medium hover:bg-steel-100">
                Work out the tax
              </button>
              {typedTax !== "" && taxRate === null && (
                <span className="text-red-600">Type the rate as a percentage under 100, such as 8.25.</span>
              )}
              {Number(plan.taxTotal) > 0 && plan.payers.length > 1 && (
                <span className="text-ink-700">
                  Each payer is taxed on their own part of each line, and the tax adds up to the tax on the whole
                  job: <Money value={plan.taxTotal} />.
                </span>
              )}
            </form>
          )}

          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {plan.payers.map((payer) => (
              <li key={payer.customerId} className="rounded-md border border-steel-200 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{payer.name}</span>
                  <span className="font-medium"><Money value={payer.totalWithTax} /></span>
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-ink-700">
                  {payer.lines.map((part) => (
                    <li key={part.key} className="flex justify-between gap-2">
                      <span>{byKey.get(part.key)?.name}{part.whole ? "" : ", their part"}</span>
                      <Money value={part.amount} />
                    </li>
                  ))}
                </ul>
                {Number(payer.memberDiscount) > 0 && (
                  <p className="mt-1 flex justify-between gap-2 text-xs text-ink-700">
                    <span>Member discount{plan.member ? `, ${plan.member.planName}` : ""}</span>
                    <Money value={`-${payer.memberDiscount}`} />
                  </p>
                )}
                {(Number(payer.taxTotal) > 0 || (payer.taxExempt && taxRate !== null)) && (
                  <p className="mt-1 flex justify-between gap-2 text-xs text-ink-700">
                    <span>{payer.taxExempt ? "Tax exempt, so no sales tax" : "Sales tax on their part"}</span>
                    <Money value={payer.taxTotal} />
                  </p>
                )}
                {payer.ceiling?.message && (
                  <p className={`mt-2 text-xs ${payer.ceiling.held ? "text-red-600" : "text-ink-700"}`}>{payer.ceiling.message}</p>
                )}
              </li>
            ))}
          </ul>
          {Number(plan.absorbed) > 0 && (
            <p className="mt-2 text-sm text-ink-700">Covered and billed to nobody: <Money value={plan.absorbed} />.</p>
          )}
        </>
      )}

      {plan.problems.length > 0 && !nothing && (
        <ul className="mt-3 space-y-1 rounded-md border border-amber-700/20 bg-amber-tint p-3 text-sm text-ink-900">
          {plan.problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}

      {canBill && !nothing && (
        <ActionForm action={billThisJob} hidden={{ jobId, taxRate: taxRate ?? "", lineRates: lineRates.join(",") }}
                    submit={plan.payers.length > 1 ? `Bill in ${plan.payers.length} parts` : "Bill this job"}
                    className="mt-3 flex flex-wrap items-center gap-3" />
      )}
    </section>
  );
}
