import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { recurring } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * RECURRING WORK
 *
 * A pool route, a quarterly pest treatment, a commercial filter change.
 * Separate from an agreement's included visits: this is work a company runs
 * without having sold anybody a membership.
 *
 * THE MODEL IS SHOWN ON EVERY ROW, and it is not decoration. The four behave
 * differently in a way that decides whether a route drifts, and a screen
 * that hid it behind "every 7 days" would make two schedules that produce
 * completely different dates look identical.
 */
const MODEL_LABEL: Record<string, string> = {
  rule: "On the calendar",
  anchored_to_completion: "From the last visit",
  materialized: "Dates fixed individually",
  manual: "Rebooked by hand",
};

const MODEL_MEANING: Record<string, string> = {
  rule: "Every so many days from the start date, whatever happens in between.",
  anchored_to_completion:
    "Counted from when the technician was actually there, so a missed week moves the whole series along instead of losing a visit.",
  materialized: "Each date exists as its own row and has been edited by hand.",
  manual: "No rule. Somebody books the next one each time.",
};

const MONTHS = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default async function RecurringPage() {
  const user = await requireSetupUser();
  const schedules = await recurring.list({ actor: user.actor, db: getDb() });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Recurring work" count={schedules.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Routes and repeat visits. Every date here is a calendar date in your
        own timezone: a visit due on the 15th is due on the 15th.
      </p>

      {schedules.length === 0 ? (
        <Empty title="Nothing recurring yet">
          A pool route, a quarterly treatment, a filter change. Work that
          comes back on a cadence, as opposed to the visits a membership
          includes.
        </Empty>
      ) : (
        <Table
          head={
            <>
              <Th>Work</Th><Th>Customer</Th><Th>How it repeats</Th>
              <Th>Last done</Th><Th>Next due</Th><Th>State</Th>
            </>
          }
        >
          {schedules.map((schedule) => (
            <tr key={schedule.id}>
              <Td className="font-medium">{schedule.label}</Td>
              <Td className="text-ink-700">{schedule.customerName ?? ""}</Td>
              <Td className="text-ink-700">
                <span title={MODEL_MEANING[schedule.model]}>
                  {MODEL_LABEL[schedule.model] ?? schedule.model}
                </span>
                <span className="ml-2 text-ink-500">{cadence(schedule)}</span>
              </Td>
              <Td className="text-ink-700 tabular-nums">
                {/*
                  When the technician was actually there. On the anchored
                  model this is what the next date is counted from, so it is
                  shown rather than left in the record.
                */}
                {schedule.lastOccurredOn ?? <span className="text-ink-500">Never</span>}
              </Td>
              <Td className="tabular-nums">
                <span className={schedule.nextDueOn && schedule.nextDueOn < today ? "text-red-600" : undefined}>
                  {schedule.nextDueOn ?? <span className="text-ink-500">Series finished</span>}
                </span>
              </Td>
              <Td>
                {schedule.active
                  ? <Chip tone="success">Running</Chip>
                  : <Chip tone="neutral">Paused</Chip>}
                {schedule.exceptions > 0 && (
                  /*
                    Named, because a schedule whose dates do not match its
                    rule is otherwise a mystery. A skipped visit is data: the
                    customer told us something.
                  */
                  <span className="ml-2 text-xs text-ink-500">
                    {schedule.exceptions} skipped or moved
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

/** The cadence in words, which is not the same thing as the model. */
function cadence(schedule: { intervalDays: number | null; anchorMonths: number[] }): string {
  if (schedule.anchorMonths.length > 0) {
    return schedule.anchorMonths.map((month) => MONTHS[month] ?? String(month)).join(" and ");
  }
  if (!schedule.intervalDays) return "";
  if (schedule.intervalDays === 7) return "weekly";
  if (schedule.intervalDays === 14) return "fortnightly";
  if (schedule.intervalDays % 7 === 0) return `every ${schedule.intervalDays / 7} weeks`;
  return `every ${schedule.intervalDays} days`;
}
