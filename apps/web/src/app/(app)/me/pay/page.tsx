import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { payroll } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { Empty, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * MY PAY
 *
 * The person's own statement for each pay period payroll has closed: their
 * lines exactly as the register and the export to the bureau carried them,
 * and the commission behind the commission lines, job by job. Open periods
 * are left off, because a figure read on Tuesday that has moved by Friday is
 * a dispute rather than a statement.
 *
 * What the bureau then withheld is the bureau's: this is gross pay.
 */
export default async function MyPayPage() {
  const user = await requireSetupUser();
  const zone = user.organizationTimezone;
  if (!can(user.actor, "payroll:own")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <Crumb href="/me">My record</Crumb>
        <h1 className="mt-1 text-xl font-semibold">My pay</h1>
        <Empty title="Not part of your access">Your company shows pay somewhere else. Ask the office.</Empty>
      </div>
    );
  }
  const own = await payroll.ownStatements({ actor: user.actor, db: getDb() });
  /** The last day of a period, which ends at midnight starting the next. */
  const lastDay = (end: Date) => formatIn(new Date(end.getTime() - 1), zone, { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <Crumb href="/me">My record</Crumb>
      <h1 className="mt-1 text-xl font-semibold">My pay</h1>
      <p className="mt-1 text-sm text-ink-700">
        Gross pay for each pay period once payroll has closed it, line by line as it went to payroll. Tax and
        anything else taken out is on the statement from whoever runs your payroll. What you were paid back for
        something you bought for the company, or for a day away, is paid on top with no tax taken from it.
      </p>

      {!own.technician ? (
        <Empty title="No hours here">You are not set up on the board, so there are no hours, commission or tips to show.</Empty>
      ) : own.statements.length === 0 ? (
        <Empty title="No closed pay periods yet">A statement appears here once payroll closes a period.</Empty>
      ) : (
        <div className="mt-6 space-y-8">
          {own.statements.map((s) => (
            <section key={s.periodId} aria-label={s.label} className="rounded border border-steel-200 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold">{s.label}</h2>
                <span className="text-sm text-ink-500">
                  {formatIn(s.periodStart, zone, { month: "short", day: "numeric" })} to {lastDay(s.periodEnd)}, closed {formatIn(s.closedAt, zone, { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>
              {s.problems.length > 0 ? (
                <div className="mt-2 rounded border border-amber-700 bg-amber-tint p-3 text-sm">
                  <p className="font-medium">Your statement for this period could not be worked out. Ask the office:</p>
                  <ul className="mt-1 list-disc pl-5">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
              ) : null}
              {s.statement ? (
                <>
                  <Table head={<><Th>What</Th><Th className="text-right">Hours</Th><Th className="text-right">Rate</Th><Th className="text-right">Amount</Th></>}>
                    {s.statement.lines.map((line, index) => (
                      <tr key={`${line.kind}-${index}`}>
                        <Td>
                          {line.label}
                          <span className="block text-xs text-ink-500">{line.explanation}</span>
                        </Td>
                        <Td className="text-right font-mono tabular-nums">{line.hours ?? ""}</Td>
                        <Td className="text-right">{line.rate ? <Money value={line.rate} /> : ""}</Td>
                        <Td className="text-right"><Money value={line.amount} /></Td>
                      </tr>
                    ))}
                  </Table>
                  <p className="mt-2 text-right text-sm font-semibold">Gross <Money value={s.statement.gross} /></p>
                  {Number(s.statement.nonTaxable) !== 0 ? (
                    <p className="mt-1 text-right text-sm text-ink-700">
                      Paid back on top, with no tax taken: <Money value={s.statement.nonTaxable} />
                    </p>
                  ) : null}
                  {Number(s.statement.carriedForward) !== 0 ? (
                    <p className="mt-1 text-right text-sm text-ink-700">
                      Carried to your next period: <Money value={s.statement.carriedForward} />
                    </p>
                  ) : null}
                  {s.statement.warnings.map((w) => <p key={w} className="mt-1 text-sm text-amber-700">{w}</p>)}
                </>
              ) : s.problems.length === 0 ? (
                <p className="mt-2 text-sm text-ink-700">Nothing for you in this period.</p>
              ) : null}
              {s.commissions.length > 0 ? (
                <>
                  <h3 className="mt-4 text-sm font-semibold">Commission behind it</h3>
                  <ul className="mt-1 space-y-1 text-sm">
                    {s.commissions.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center gap-2">
                        <span>Invoice {c.invoiceNumber}</span>
                        <Money value={c.amount} />
                        {c.kind === "reversed" ? <Chip tone="warning">Taken back</Chip> : null}
                        {c.paidAt ? <Chip tone="success">Paid</Chip> : <Chip tone="neutral">Owed</Chip>}
                        <span className="text-ink-500">{c.explanation}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
