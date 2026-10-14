import { can } from "@opentradesos/core";
import { branches, holidays, type ServiceContext } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { formatDay } from "@/lib/dates";
import { addHoliday, removeHoliday } from "./actions";

/**
 * THE HOLIDAY LIST, AND A FORM TO ADD TO IT
 *
 * Drawn under Settings and on the setup wizard's hours step, from the same
 * service, because the list is the other half of "when are you open". What
 * it changes is said above the list in plain words, so an owner adding
 * Christmas knows the booking page, the phones and the recurring tasks all
 * hear about it.
 */
export async function HolidaysSection({ ctx, timezone }: { ctx: ServiceContext; timezone: string }) {
  const list = await holidays.list(ctx);
  const writes = can(ctx.actor, "booking:configure");
  /**
   * Who a holiday is for: the whole company or one branch. Somebody who sees
   * one branch keeps only that branch's own, so they are offered only it. A
   * company with no branches is offered nothing to choose.
   */
  const choices = await branches.options(ctx).catch(() => null);
  const forOptions = !choices || choices.branches.length === 0 ? [] : choices.narrowed
    ? choices.branches.filter((b) => b.id === choices.yours).map((b) => ({ value: b.id, label: `${b.name} only` }))
    : [{ value: "", label: "The whole company" }, ...choices.branches.map((b) => ({ value: b.id, label: `${b.name} only` }))];

  return (
    <section aria-label="Holidays">
      <p className="max-w-2xl text-sm text-ink-700">
        Days you close, or open with different hours. On a day in this list its hours replace your usual ones:
        the booking page offers no times on a closed day and only times inside a short day&rsquo;s hours, calls
        go where your after hours calls go, the review reply clock does not run, and a recurring task set to
        skip holidays raises nothing. The list starts empty: only days you add are here.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A day can move each year, like the fourth Thursday of November, or be kept on the Monday when it falls on a
        Sunday. A branch can keep its own days off as well as the company&rsquo;s: its booking page, its jobs&rsquo;
        rates, its tasks and its days on the schedule read both.
      </p>

      {list.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">No holidays on the list.</p>
      ) : (
        <Table label="Holidays" head={<><Th>Day</Th><Th>When</Th><Th>Next</Th><Th>For</Th><Th>Hours</Th><Th>{""}</Th></>}>
          {list.map((h) => (
            <tr key={h.id}>
              <Td>
                <span className="font-medium">{h.name}</span>
                {h.repeatsYearly ? <Chip tone="info" className="ml-2">Every year</Chip> : null}
                {h.nextOn === null ? <Chip tone="neutral" className="ml-2">Passed</Chip> : null}
              </Td>
              <Td className="text-ink-700">{h.when}</Td>
              <Td>{formatDay(h.nextOn ?? h.date, timezone)}</Td>
              <Td className="text-ink-700">{h.branchName ?? "Whole company"}</Td>
              <Td className="text-ink-700">{h.hours}</Td>
              <Td>
                {writes ? (
                  <ActionForm action={removeHoliday} submit="Remove" tone="quiet" hidden={{ id: h.id }} className="flex items-center gap-2" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <div className="mt-6 rounded-md border border-steel-200 p-4">
          <h3 className="text-base font-semibold">Add a holiday</h3>
          <ActionForm action={addHoliday} submit="Add holiday" className="mt-3 grid gap-3 sm:grid-cols-2">
            <TextField label="Name" name="name" placeholder="Christmas Day" required maxLength={80} />
            <Select label="It falls on" name="kind" options={[
              { value: "date", label: "A date" },
              { value: "rule", label: "A day of the week in a month" },
            ]} />
            <TextField label="Date" name="date" type="date" />
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" name="repeatsYearly" value="yes" />
              Every year on this date
            </label>
            <Select label="Which one (for a day of the week)" name="week" options={[
              { value: "1", label: "First" }, { value: "2", label: "Second" }, { value: "3", label: "Third" },
              { value: "4", label: "Fourth" }, { value: "last", label: "Last" },
            ]} />
            <Select label="Day of the week" name="weekday" options={[
              "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
            ].map((label, i) => ({ value: String(i), label }))} />
            <Select label="Month" name="month" options={[
              "January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December",
            ].map((label, i) => ({ value: String(i + 1), label }))} />
            <Select label="When it lands on a weekend" name="observed" options={[
              { value: "as_is", label: "Keep it on the day" },
              { value: "sunday_to_monday", label: "The Monday after, when it is a Sunday" },
              { value: "weekend_to_weekday", label: "The nearest weekday: Friday before a Saturday, Monday after a Sunday" },
            ]} />
            {forOptions.length > 0 ? <Select label="For" name="businessUnitId" options={forOptions} /> : null}
            <Select label="That day" name="day" options={[
              { value: "closed", label: "Closed all day" },
              { value: "open", label: "Open, with the hours below" },
            ]} />
            <TextField label="Opens (when open)" name="opensAt" type="time" defaultValue="08:00" />
            <TextField label="Closes (when open)" name="closesAt" type="time" defaultValue="12:00" />
          </ActionForm>
          <p className="mt-2 text-xs text-ink-500">
            A day of the week in a month comes back every year: the fourth Thursday of November is Thanksgiving, the
            last Monday of May is Memorial Day. Moving a day off a weekend is for one that comes back every year.
          </p>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-500">Changing the list needs the permission to set up online booking.</p>
      )}
    </section>
  );
}
