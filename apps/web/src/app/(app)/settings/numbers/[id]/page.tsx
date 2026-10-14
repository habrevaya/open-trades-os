import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { numberHours } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Phone } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay } from "@/lib/dates";
import { Hours } from "../../../booking/Forms";
import { saveHoursFrom, saveOwnWeek, addOwnHoliday, removeOwnHoliday } from "./actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The week in one line: "Mon 08:00 to 17:00, Sat closed". */
function weekWords(days: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[]): string {
  return days.map((d) => `${DAYS[d.dayOfWeek]} ${d.closed || !d.opensAt || !d.closesAt ? "closed" : `${d.opensAt} to ${d.closesAt}`}`).join(", ");
}

/**
 * SETTINGS, A PHONE NUMBER'S HOURS
 *
 * What a number's calls are routed by when it routes by hours or a phone menu
 * answers it: the hours of the branch it answers for, the company's, or its
 * own week and days off. An emergency line open around the clock keeps its
 * own, and then the company's holidays do not shut it; a day it closes is
 * added to its own list. `settings:read` to look and `settings:write` to
 * change, as the number's routing is.
 */
export default async function NumberHoursPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  if (!can(user.actor, "settings:read")) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = { actor: user.actor, db: getDb() };
  const number = await numberHours.view(ctx, { id }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "NotFoundError") return null;
    throw error;
  });
  if (!number) notFound();
  const writes = can(user.actor, "settings:write");
  const branchChoice = number.branchName
    ? `${number.branchName}'s hours, the branch it answers for`
    : "Its branch's hours (it answers for no branch, so the company's)";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Hours for this number" />
      <p className="mt-2 text-sm text-ink-700">
        <span className="font-medium"><Phone value={number.e164} /></span>
        {number.label ? <span className="ml-2 text-ink-500">{number.label}</span> : null}
        {" "}<a href="/settings" className="underline underline-offset-4">Back to Settings</a>
      </p>

      {!number.usesHours ? (
        <p className="mt-3 max-w-2xl rounded-md border border-amber-700/20 bg-amber-tint p-3 text-sm text-ink-900">
          Calls to this number are not routed by hours yet, so nothing here changes where they ring. Tick
          &quot;By business hours&quot; beside it on Settings, or answer it with a phone menu.
        </p>
      ) : null}

      <section className="mt-6" aria-labelledby="now">
        <h2 id="now" className="text-base font-semibold">What its calls go by now</h2>
        <p className="mt-1 text-sm text-ink-700">
          <Chip tone={number.routedBy.source === "none" ? "warning" : "info"}>{number.routedBy.whose}</Chip>
          {number.routedBy.days.length > 0 ? <span className="ml-2">{weekWords(number.routedBy.days)}.</span> : null}
        </p>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          {number.hoursFrom === "own"
            ? "Its own days off below apply. The company's holidays do not."
            : "The company's holidays apply, and its branch's own when it follows its branch. They are on Settings, Holidays."}
        </p>
        {writes ? (
          <ActionForm action={saveHoursFrom} submit="Save where its hours come from" hidden={{ id: number.id }}
                      className="mt-3 flex flex-wrap items-end gap-3">
            <Select label="Its hours come from" name="hoursFrom" defaultValue={number.hoursFrom} className="block w-full max-w-md"
                    options={[
                      { value: "branch", label: branchChoice },
                      { value: "company", label: "The company's hours" },
                      ...(number.ownWeek.length > 0 ? [{ value: "own", label: "Its own hours and days off" }] : []),
                    ]} />
          </ActionForm>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="own">
        <h2 id="own" className="text-base font-semibold">Its own hours</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {number.ownWeek.length > 0
            ? `${weekWords(number.ownWeek)}.${number.hoursFrom === "own" ? "" : " Kept for when it keeps its own hours again."}`
            : "Not set. Saving a week here makes this number keep its own hours."}
        </p>
        {writes ? (
          <Hours current={number.ownWeek} action={saveOwnWeek} hidden={{ id: number.id }} submit="Save its own hours" />
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="days">
        <h2 id="days" className="text-base font-semibold">Its own days off</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          Used only while it keeps its own hours. On a closed day its calls go where after hours calls go; on a
          short day its own hours that day decide.
        </p>
        {number.ownHolidays.length === 0 ? (
          <div className="mt-3"><Empty title="No days off of its own">A day it closes, or opens shorter, goes here.</Empty></div>
        ) : (
          <Table label="Its own days off" head={<><Th>Day</Th><Th>When</Th><Th>Next</Th><Th>Hours</Th><Th>{""}</Th></>}>
            {number.ownHolidays.map((h) => (
              <tr key={h.id}>
                <Td className="font-medium">{h.name}</Td>
                <Td className="text-ink-700">{h.when}</Td>
                <Td>{formatDay(h.nextOn ?? h.date, user.organizationTimezone)}</Td>
                <Td className="text-ink-700">{h.hours}</Td>
                <Td>
                  {writes ? (
                    <ActionForm action={removeOwnHoliday} submit="Remove" tone="quiet" hidden={{ id: number.id, holidayId: h.id }}
                                className="flex items-center gap-2" />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {writes ? (
          <ActionForm action={addOwnHoliday} submit="Add day off" hidden={{ id: number.id }} className="mt-4 grid gap-3 sm:grid-cols-2">
            <TextField label="Name" name="name" placeholder="Line maintenance" required maxLength={80} />
            <TextField label="Date" name="date" type="date" required />
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" name="repeatsYearly" value="yes" />
              Every year on this date
            </label>
            <Select label="That day" name="day" options={[
              { value: "closed", label: "Closed all day" },
              { value: "open", label: "Open, with the hours below" },
            ]} />
            <TextField label="Opens (when open)" name="opensAt" type="time" defaultValue="08:00" />
            <TextField label="Closes (when open)" name="closesAt" type="time" defaultValue="12:00" />
          </ActionForm>
        ) : null}
      </section>
    </div>
  );
}
