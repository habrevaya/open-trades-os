import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { businessHours, menuHours } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay } from "@/lib/dates";
import { Hours } from "../../../../booking/Forms";
import { saveMenuHoursFrom, saveMenuOwnWeek, addMenuOwnHoliday, removeMenuOwnHoliday } from "./actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The week in one line: "Mon 08:00 to 17:00, Sat closed". */
function weekWords(days: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[]): string {
  return days.map((d) => `${DAYS[d.dayOfWeek]} ${d.closed || !d.opensAt || !d.closesAt ? "closed" : `${d.opensAt} to ${d.closesAt}`}`).join(", ");
}

/**
 * SETTINGS, A PHONE MENU'S HOURS
 *
 * Whose hours decide whether a menu is open: the number each call came in on
 * (every menu's until now), a branch's or the company's with their seasons
 * and holidays, or a week and days off of its own. A Sales menu behind the
 * main menu that shuts at noon keeps its own. `settings:read` to look and
 * `settings:write` to change, as the menu is.
 */
export default async function MenuHoursPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  if (!can(user.actor, "settings:read")) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = { actor: user.actor, db: getDb() };
  const menu = await menuHours.view(ctx, { id }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "NotFoundError") return null;
    throw error;
  });
  if (!menu) notFound();
  const writes = can(user.actor, "settings:write");
  const branches = (await businessHours.list(ctx)).branches;
  const current = menu.hoursFrom === "branch" && menu.businessUnitId ? `branch:${menu.businessUnitId}` : menu.hoursFrom;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title={`Hours for the ${menu.name} menu`} />
      <p className="mt-2 text-sm text-ink-700">
        {menu.numbers.length > 0 ? <span>Answers {menu.numbers.map((n) => n.e164).join(", ")}. </span> : null}
        <a href="/settings/phone" className="underline underline-offset-4">Back to phone menus</a>
      </p>

      {!menu.hasAfterHours ? (
        <p className="mt-3 max-w-2xl rounded-md border border-amber-700/20 bg-amber-tint p-3 text-sm text-ink-900">
          This menu answers at every hour, so it cannot keep hours of its own yet. On Settings, Phone, open the menu and
          choose where calls go when it is closed. Then come back here.
        </p>
      ) : null}

      <section className="mt-6" aria-labelledby="now">
        <h2 id="now" className="text-base font-semibold">What it goes by now</h2>
        <p className="mt-1 text-sm text-ink-700">
          <Chip tone={menu.goesBy.source === "none" ? "warning" : "info"}>{menu.goesBy.whose}</Chip>
          {menu.goesBy.days.length > 0 ? <span className="ml-2">{weekWords(menu.goesBy.days)}.</span> : null}
        </p>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          {menu.hoursFrom === "number"
            ? "Where it answers a number, it is open when that number is. Reached from another menu, it is always open."
            : menu.hoursFrom === "own"
              ? "Its own days off below apply. The company's holidays do not. It checks its hours however a caller reaches it."
              : "Summer hours and holidays apply on their dates. It checks its hours however a caller reaches it."}
        </p>
        {writes ? (
          <ActionForm action={saveMenuHoursFrom} submit="Save whose hours it goes by" hidden={{ id: menu.id }}
                      className="mt-3 flex flex-wrap items-end gap-3">
            <Select label="Its hours come from" name="hoursFrom" defaultValue={current} className="block w-full max-w-md"
                    options={[
                      { value: "number", label: "The number each call came in on" },
                      { value: "company", label: "The company's hours" },
                      ...branches.map((b) => ({ value: `branch:${b.businessUnitId}`, label: `${b.name}'s hours` })),
                      ...(menu.ownWeek.length > 0 ? [{ value: "own", label: "Its own hours and days off" }] : []),
                    ]} />
          </ActionForm>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="own">
        <h2 id="own" className="text-base font-semibold">Its own hours</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {menu.ownWeek.length > 0
            ? `${weekWords(menu.ownWeek)}.${menu.hoursFrom === "own" ? "" : " Kept for when it keeps its own hours again."}`
            : "Not set. Saving a week here makes this menu keep its own hours."}
        </p>
        {writes && menu.hasAfterHours ? (
          <Hours current={menu.ownWeek} action={saveMenuOwnWeek} hidden={{ id: menu.id }} submit="Save its own hours" />
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="days">
        <h2 id="days" className="text-base font-semibold">Its own days off</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          Used only while it keeps its own hours. On a closed day its calls go where after hours calls go; on a
          short day its own hours that day decide.
        </p>
        {menu.ownHolidays.length === 0 ? (
          <div className="mt-3"><Empty title="No days off of its own">A day it closes, or opens shorter, goes here.</Empty></div>
        ) : (
          <Table label="Its own days off" head={<><Th>Day</Th><Th>When</Th><Th>Next</Th><Th>Hours</Th><Th>{""}</Th></>}>
            {menu.ownHolidays.map((h) => (
              <tr key={h.id}>
                <Td className="font-medium">{h.name}</Td>
                <Td className="text-ink-700">{h.when}</Td>
                <Td>{formatDay(h.nextOn ?? h.date, user.organizationTimezone)}</Td>
                <Td className="text-ink-700">{h.hours}</Td>
                <Td>
                  {writes ? (
                    <ActionForm action={removeMenuOwnHoliday} submit="Remove" tone="quiet" hidden={{ id: menu.id, holidayId: h.id }}
                                className="flex items-center gap-2" />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {writes ? (
          <ActionForm action={addMenuOwnHoliday} submit="Add day off" hidden={{ id: menu.id }} className="mt-4 grid gap-3 sm:grid-cols-2">
            <TextField label="Name" name="name" placeholder="Sales training" required maxLength={80} />
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
