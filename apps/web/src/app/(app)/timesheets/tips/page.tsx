import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { cashTips, laborSettings } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay, todayIn } from "@/lib/dates";
import { correct, record } from "./actions";

export const dynamic = "force-dynamic";

/**
 * CASH TIPS THE OFFICE PUTS ON SOMEBODY'S PAY
 *
 * A customer hands a technician a twenty for themselves. The technician
 * records it on the phone; when they did not, or got the amount wrong, the
 * office knows because the customer said so. Recording one or changing one
 * needs a reason, which the technician reads beside the tip, and a tip in a
 * pay period that has gone to payroll is not changed here: the period is
 * reopened first. A tip that was never given is corrected to nothing.
 *
 * Nothing is booked: the company never held the money. It is pay that has to
 * be reported, so it goes on the register and the file as `cash_tip`.
 *
 * `tip:record`, narrowed to the people the reader's timesheet scope reaches.
 */
export default async function CashTipsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "tip:record")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Cash tips" />
        <Empty title="Cash tips are not part of your access">Somebody who looks after pay records these.</Empty>
      </div>
    );
  }
  const [tips, people] = await Promise.all([cashTips.list(ctx), laborSettings.crewRates(ctx)]);
  const today = todayIn(zone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Cash tips" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Cash a customer handed a technician for themselves. It is theirs to keep and nothing is booked, but it is
        pay, so it is reported with their pay. Technicians record their own on the phone; put one here when they
        did not, or change one that is wrong. Either way you say why, and they read it.
      </p>

      <section className="mt-6" aria-labelledby="put-on">
        <h2 id="put-on" className="text-base font-semibold">Put a tip on somebody&apos;s pay</h2>
        <ActionForm action={record} submit="Put it on their pay" className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
          <Select label="Who was tipped" name="technicianId" required
                  options={[{ value: "", label: "Choose a person" }, ...people.filter((p) => p.active).map((p) => ({ value: p.id, label: p.displayName }))]} />
          <TextField label="The tip (dollars)" name="amount" inputMode="decimal" required placeholder="20.00" />
          <TextField label="Day it was handed over" name="receivedOn" type="date" defaultValue={today} max={today} />
          <TextField label="Job number (if it was for a job)" name="jobNumber" inputMode="numeric" placeholder="1042" />
          <TextField label="Why you are recording it" name="reason" required maxLength={500}
                     placeholder="Mrs Delacroix rang to say she gave Ray twenty dollars" className="block sm:col-span-2" />
        </ActionForm>
      </section>

      <section className="mt-10" aria-labelledby="on-pay">
        <h2 id="on-pay" className="text-base font-semibold">On pay in the last four months</h2>
        {tips.length === 0 ? (
          <Empty title="No cash tips yet">The ones technicians record on their phones, and the ones you add above, are listed here.</Empty>
        ) : (
          <Table label="Cash tips" head={<><Th>Who</Th><Th>Day</Th><Th className="text-right">Tip</Th><Th>Recorded</Th><Th>Change it</Th></>}>
            {tips.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">{t.technicianName}</Td>
                <Td>
                  {formatDay(dayOf(t.receivedAt, zone), zone)}
                  {t.jobId ? <span className="block text-xs text-ink-500"><Link href={`/jobs/${t.jobId}`} className="text-blue-600 underline underline-offset-4">Job {t.jobNumber}</Link></span> : null}
                </Td>
                <Td className="text-right tabular-nums"><Money value={t.amount} /></Td>
                <Td>
                  {t.recordedBy === "office" ? <Chip tone="neutral">By {t.recordedByName ?? "the office"}</Chip> : <Chip tone="neutral">By them, on the phone</Chip>}
                  {t.note ? <span className="mt-1 block text-xs text-ink-700">{t.note}</span> : null}
                  {t.corrections.map((c) => (
                    <span key={`${c.at}`} className="mt-1 block text-xs text-ink-500">
                      <Money value={c.previousAmount} /> to <Money value={c.newAmount} />, {c.correctedByName ?? "the office"}: {c.reason}
                    </span>
                  ))}
                </Td>
                <Td>
                  <ActionForm action={correct} submit={`Change ${t.technicianName}'s ${formatDay(dayOf(t.receivedAt, zone), zone)} tip`} tone="quiet"
                              hidden={{ id: t.id }} className="flex flex-col items-start gap-2">
                    <input name="amount" required inputMode="decimal" aria-label={`New amount for ${t.technicianName}'s tip on ${formatDay(dayOf(t.receivedAt, zone), zone)}`}
                           placeholder="New amount, 0 to take it off" className="h-9 w-52 rounded border border-steel-300 px-2 text-sm" />
                    <input name="reason" required maxLength={500} aria-label={`Why ${t.technicianName}'s tip on ${formatDay(dayOf(t.receivedAt, zone), zone)} is changed`}
                           placeholder="Why, for them" className="h-9 w-52 rounded border border-steel-300 px-2 text-sm" />
                  </ActionForm>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}

/** The company's date an instant falls on, for the day column. */
function dayOf(instant: Date, zone: string): string {
  return todayIn(zone, instant);
}
