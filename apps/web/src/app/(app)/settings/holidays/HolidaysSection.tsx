import { can } from "@opentradesos/core";
import { holidays, type ServiceContext } from "@opentradesos/api/services";
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

  return (
    <section aria-label="Holidays">
      <p className="max-w-2xl text-sm text-ink-700">
        Days you close, or open with different hours. On a day in this list its hours replace your usual ones:
        the booking page offers no times on a closed day and only times inside a short day&rsquo;s hours, calls
        go where your after hours calls go, the review reply clock does not run, and a recurring task set to
        skip holidays raises nothing. The list starts empty: only days you add are here.
      </p>

      {list.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">No holidays on the list.</p>
      ) : (
        <Table label="Holidays" head={<><Th>Day</Th><Th>Date</Th><Th>Hours</Th><Th>{""}</Th></>}>
          {list.map((h) => (
            <tr key={h.id}>
              <Td>
                <span className="font-medium">{h.name}</span>
                {h.repeatsYearly ? <Chip tone="info" className="ml-2">Every year</Chip> : null}
                {h.nextOn === null ? <Chip tone="neutral" className="ml-2">Passed</Chip> : null}
              </Td>
              <Td>{formatDay(h.nextOn ?? h.date, timezone)}</Td>
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
            <TextField label="Date" name="date" type="date" required />
            <Select label="That day" name="day" options={[
              { value: "closed", label: "Closed all day" },
              { value: "open", label: "Open, with the hours below" },
            ]} />
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" name="repeatsYearly" value="yes" />
              Every year on this date
            </label>
            <TextField label="Opens (when open)" name="opensAt" type="time" defaultValue="08:00" />
            <TextField label="Closes (when open)" name="closesAt" type="time" defaultValue="12:00" />
          </ActionForm>
          <p className="mt-2 text-xs text-ink-500">
            A holiday that moves, like the fourth Thursday of November, is added for the year it falls in.
          </p>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-500">Changing the list needs the permission to set up online booking.</p>
      )}
    </section>
  );
}
