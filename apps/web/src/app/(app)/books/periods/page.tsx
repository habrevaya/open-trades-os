import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { accounting } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { formatDay, formatIn } from "@/lib/dates";
import { closePeriod, reopenPeriod } from "./actions";

export const dynamic = "force-dynamic";

/** The day before a `YYYY-MM-DD` day, counted on the calendar rather than in any clock's zone. */
function dayBefore(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * BOOKS → CLOSING THE BOOKS
 *
 * Closing a month says it is filed: from then on nothing is posted on or
 * before its last day, not an invoice, a payment, a journal or a back dated
 * import, and the accounting sync sends nothing dated in it. Reopening is
 * possible, with a reason, because a month that cannot be reopened gets
 * worked around by dating things where they do not belong.
 *
 * Here rather than under the accounting settings, because a close holds the
 * ledger whether or not QuickBooks or Xero is connected. Reading needs
 * `accounting:sync` and closing or reopening `accounting:close`, the
 * permissions of `GET /v1/accounting/periods` and the two routes that change
 * one; every write goes through the service those routes call, so the rules
 * and the sentences refusing them are the same.
 */
export default async function ClosingTheBooksPage() {
  const user = await requireSetupUser();
  const tz = user.organizationTimezone;

  if (!can(user.actor, "accounting:sync")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Closing the books" />
        <Empty title="Not shown to your role">
          Which months are closed needs the Run and configure the accounting sync permission.
        </Empty>
      </div>
    );
  }

  const ctx = { actor: user.actor, db: getDb() };
  const periods = await accounting.listPeriods(ctx);
  const closes = can(user.actor, "accounting:close");
  /** The latest close still in force, which is what refuses a posting. */
  const inForce = periods.find((p) => p.reopenedAt === null) ?? null;
  const today = time.dateIn(new Date(), tz);
  const lastMonthEnd = dayBefore(`${today.slice(0, 8)}01`);
  const suggested = inForce && inForce.periodEnd >= lastMonthEnd ? today : lastMonthEnd;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Closing the books" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Close a month once it is filed. After that nothing can be posted on or before its last day: no invoice,
        payment, credit, journal entry or import. The sync stops sending anything dated in it to QuickBooks or Xero.
        A correction is made today, in the open month. If a month was closed by mistake, reopen it and say why.
      </p>
      <p role="status" aria-live="polite" className="mt-4 rounded border border-steel-200 bg-steel-100 px-3 py-2 text-sm text-ink-900">
        {inForce
          ? `The books are closed through ${formatDay(inForce.periodEnd, tz)}.`
          : "No month is closed. Anything can be posted on any day."}
      </p>

      {closes ? (
        <section aria-label="Close a month" className="mt-6 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">Close the books</h2>
          <ActionForm action={closePeriod} submit="Close the books through this day" className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
              <TextField label="Last day to close" name="periodEnd" type="date" required
                         defaultValue={suggested} max={today} />
              <TextField label="Note (optional)" name="note" placeholder="Third quarter filed with the state" maxLength={2000} />
            </div>
            <p className="text-xs text-ink-500">
              A day after the one already closed, and not after today.
            </p>
          </ActionForm>
        </section>
      ) : (
        <p className="mt-6 text-sm text-ink-700">
          Closing and reopening a month need the Close an accounting period permission.
        </p>
      )}

      <section aria-label="Closes so far" className="mt-8">
        <h2 className="text-base font-semibold">Closes so far</h2>
        {periods.length === 0 ? (
          <Empty title="Nothing closed yet">When a month is closed it is listed here, and stays listed if it is reopened.</Empty>
        ) : (
          <Table label="Closes so far" head={<><Th>Closed through</Th><Th>When</Th><Th>Note</Th><Th>Now</Th></>}>
            {periods.map((p) => (
              <tr key={p.id}>
                <Td className="whitespace-nowrap">{formatDay(p.periodEnd, tz)}</Td>
                <Td className="whitespace-nowrap">{formatIn(p.closedAt, tz)}</Td>
                <Td>{p.note ?? <span className="text-ink-500">None</span>}</Td>
                <Td>
                  {p.reopenedAt ? (
                    <>
                      <Chip tone="warning">Reopened {formatIn(p.reopenedAt, tz)}</Chip>
                      {p.reopenedReason ? <span className="mt-1 block text-sm text-ink-700">{p.reopenedReason}</span> : null}
                    </>
                  ) : (
                    <>
                      <Chip tone={p.id === inForce?.id ? "info" : "neutral"}>Closed</Chip>
                      {closes ? (
                        <ActionForm action={reopenPeriod} submit={`Reopen ${formatDay(p.periodEnd, tz)}`} tone="quiet"
                                    hidden={{ periodEnd: p.periodEnd }} className="mt-2 space-y-2">
                          <TextField label="Why it is being reopened" name="reason" required maxLength={2000}
                                     placeholder="A supplier bill for September came in late" />
                        </ActionForm>
                      ) : null}
                    </>
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
