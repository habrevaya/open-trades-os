import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { expenses, laborSettings } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay, formatIn, todayIn } from "@/lib/dates";
import { decide, perDiem, removeDay } from "./actions";

export const dynamic = "force-dynamic";

const TABS = [
  { value: "pending", label: "Waiting" },
  { value: "approved", label: "Approved" },
  { value: "refused", label: "Refused" },
  { value: "all", label: "All" },
] as const;

/**
 * WHAT PEOPLE PAID FOR THE COMPANY, AND A DAY AWAY
 *
 * The expenses people recorded from the phone or from My record, waiting ones
 * first, each with its receipt, the job it was for and what the office can
 * do: approve, or refuse with a reason the person reads. An approved one
 * goes to the payroll bureau as a non-taxable line in the pay period it is
 * approved in. A day away is the company's flat rate against a job, recorded
 * here and paid the same way.
 *
 * NOTHING HERE IS POSTED TO THE LEDGER. They are paid through payroll and
 * counted in the job's cost.
 *
 * `expense:approve`, narrowed to the people the reader's timesheet scope
 * reaches, so a branch manager decides their own branch's.
 */
export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "expense:approve")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Expenses" />
        <Empty title="Expenses are not part of your access">Somebody who approves what people spend for the company answers these.</Empty>
      </div>
    );
  }

  const { status } = await searchParams;
  const tab = TABS.find((t) => t.value === status)?.value ?? "pending";
  const [listing, days, people] = await Promise.all([
    expenses.list(ctx, tab === "all" ? {} : { status: tab }),
    expenses.listPerDiem(ctx, {}),
    laborSettings.crewRates(ctx),
  ]);
  const today = todayIn(zone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Expenses" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        What people paid for the company out of their own pocket. An approved one is paid back through payroll
        with no tax taken from it, and counts in the cost of the job it was for. A decision is final, because
        the payroll file is built from it.
      </p>

      <nav aria-label="Which expenses" className="mt-4 flex flex-wrap gap-2 text-sm">
        {TABS.map((t) => (
          <Link key={t.value} href={`/timesheets/expenses?status=${t.value}`} aria-current={t.value === tab ? "page" : undefined}
                className={`rounded border px-3 py-1.5 ${t.value === tab ? "border-ink-900 font-medium" : "border-steel-300 text-ink-700"}`}>
            {t.label}{t.value === "pending" && listing.waiting > 0 ? ` (${listing.waiting})` : ""}
          </Link>
        ))}
      </nav>

      {listing.expenses.length === 0 ? (
        <Empty title={tab === "pending" ? "Nothing waiting" : "Nothing here"}>
          Expenses people record from their phone, or from My record, appear here.
        </Empty>
      ) : (
        <Table label="Expenses" head={<><Th>Who</Th><Th>What</Th><Th className="text-right">Amount</Th><Th>Receipt</Th><Th>Answer</Th></>}>
          {listing.expenses.map((e) => (
            <tr key={e.id}>
              <Td className="font-medium">{e.technicianName}</Td>
              <Td>
                {e.description}
                <span className="block text-xs text-ink-500">
                  {formatDay(e.spentOn, zone)}
                  {e.jobId
                    ? <>{", "}<Link href={`/jobs/${e.jobId}`} className="text-blue-600 underline underline-offset-4">job {e.jobNumber}</Link></>
                    : ", not for a job"}
                </span>
              </Td>
              <Td className="text-right tabular-nums"><Money value={e.amount} /></Td>
              <Td>
                {e.receipts > 0
                  ? Array.from({ length: e.receipts }, (_, n) => (
                    <a key={n} href={`/timesheets/expenses/${e.id}/receipt?n=${n}`} target="_blank" rel="noreferrer"
                       className="mr-2 text-blue-600 underline underline-offset-4">
                      {e.receipts > 1 ? `Receipt ${n + 1}` : "Receipt"}
                    </a>
                  ))
                  : <Chip tone="warning">No receipt</Chip>}
              </Td>
              <Td>
                {e.status === "pending" ? (
                  <div className="flex flex-col gap-2">
                    <ActionForm action={decide} submit={`Approve ${e.technicianName}'s ${e.description}`.slice(0, 80)}
                                hidden={{ id: e.id, decision: "approve" }} className="flex flex-col items-start gap-2" />
                    <ActionForm action={decide} submit="Refuse" tone="danger" hidden={{ id: e.id, decision: "refuse" }}
                                className="flex flex-wrap items-end gap-2">
                      <input name="reason" required aria-label={`Why ${e.technicianName}'s ${e.description} is refused`}
                             placeholder="Why, for them" className="h-9 w-48 rounded border border-steel-300 px-2 text-sm" />
                    </ActionForm>
                  </div>
                ) : e.status === "approved" ? (
                  <>
                    <Chip tone="success">Approved</Chip>
                    <span className="mt-1 block text-xs text-ink-500">
                      {e.decidedByName ? `${e.decidedByName}, ` : ""}{e.decidedAt ? formatIn(e.decidedAt, zone, { dateStyle: "medium" }) : ""}
                    </span>
                    <span className={`mt-1 block text-xs ${e.paidIn ? "text-ink-700" : "text-amber-700"}`}>
                      {e.paidIn ? `Goes out with ${e.paidIn.label}` : "No pay period covers it yet, so it will not go to payroll until one does."}
                    </span>
                  </>
                ) : (
                  <>
                    <Chip tone="neutral">Refused</Chip>
                    <span className="mt-1 block text-xs text-ink-700">{e.decisionReason}</span>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <section className="mt-12" aria-labelledby="days-away">
        <h2 id="days-away" className="text-base font-semibold">Days away from home</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {listing.perDiemRate
            ? <>The company pays <Money value={listing.perDiemRate} /> for a day away. Record the days somebody was away on a job: it is paid with no tax taken, and counts in the job&apos;s cost.</>
            : <>No rate is set, so no day away is paid. <Link href="/payroll/pay-rules" className="text-blue-600 underline underline-offset-4">Set what a day away is worth</Link> first.</>}
        </p>

        {listing.perDiemRate ? (
          <ActionForm action={perDiem} submit="Record the days" className="mt-4 grid max-w-3xl gap-3 sm:grid-cols-2">
            <Select label="Who was away" name="technicianId" required
                    options={[{ value: "", label: "Choose a person" }, ...people.filter((p) => p.active).map((p) => ({ value: p.id, label: p.displayName }))]} />
            <TextField label="Job number" name="jobNumber" inputMode="numeric" required placeholder="1042" />
            <TextField label="First day away" name="from" type="date" required max={today} />
            <TextField label="Last day away" name="to" type="date" max={today} />
            <TextField label="Note (optional)" name="note" maxLength={300} className="block sm:col-span-2" />
          </ActionForm>
        ) : null}

        {days.length === 0 ? (
          <p className="mt-4 text-sm text-ink-700">No days away recorded yet.</p>
        ) : (
          <Table label="Days away" head={<><Th>Who</Th><Th>Day</Th><Th>Job</Th><Th className="text-right">Amount</Th><Th>Goes out with</Th><Th>{""}</Th></>}>
            {days.map((d) => (
              <tr key={d.id}>
                <Td className="font-medium">{d.technicianName}</Td>
                <Td>{formatDay(d.day, zone)}</Td>
                <Td><Link href={`/jobs/${d.jobId}`} className="text-blue-600 underline underline-offset-4">Job {d.jobNumber}</Link></Td>
                <Td className="text-right tabular-nums"><Money value={d.amount} /></Td>
                <Td className="text-ink-700">{d.paidIn ? `${d.paidIn.label}${d.paidIn.closed ? " (closed)" : ""}` : "No pay period covers it yet"}</Td>
                <Td>
                  {d.paidIn?.closed ? null : (
                    <ActionForm action={removeDay} submit={`Take out ${d.technicianName}'s ${d.day}`} tone="quiet"
                                hidden={{ id: d.id }} className="flex flex-col items-start gap-2" />
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
