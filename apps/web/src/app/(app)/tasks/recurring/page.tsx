import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { taskRules } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField, TextArea, Select } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { TASK_PRIORITY, label } from "@/lib/labels";
import { formatDay, todayIn } from "@/lib/dates";
import { addTemplate, setTemplateActive, setTemplateSkipHolidays } from "../rule-actions";

export const dynamic = "force-dynamic";

/**
 * WORK THAT COMES ROUND AGAIN
 *
 * Check the vans on Monday, reconcile the card machine on the first. Each is
 * raised by the worker on the day, in the company's own calendar, once: the
 * task carries the template and the day and the database refuses a second.
 * A worker that was down raises the latest one rather than every day it
 * missed, because a queue full of last week's van checks is a queue people
 * stop reading.
 */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first on the form, because a working week starts on a Monday. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const minutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export default async function RecurringTasksPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const templates = await taskRules.listTemplates(ctx);
  const writes = can(user.actor, "task:write");
  const people = writes ? await taskRules.assignable(ctx) : [];
  const tz = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/tasks">Tasks</Crumb>
      <div className="mt-1"><PageHeader title="Recurring tasks" count={templates.length} /></div>

      {templates.length === 0 ? (
        <Empty title="Nothing recurs yet">Add the work that comes round every day, week or month, every few weeks, on the days you choose, or on the first or last Friday of the month, and it lands in the queue on the day.</Empty>
      ) : (
        <Table label="Recurring tasks" head={<><Th>Task</Th><Th>When</Th><Th>For</Th><Th>Next</Th><Th /></>}>
          {templates.map((t) => (
            <tr key={t.id}>
              <Td>
                <span className="font-medium">{t.title}</span>
                {t.priority !== "normal" ? <> <Chip tone="neutral">{label(TASK_PRIORITY, t.priority)}</Chip></> : null}
                {t.checklist.length > 0 ? <p className="text-xs text-ink-500">{t.checklist.length} checklist items</p> : null}
              </Td>
              <Td className="text-ink-700">{t.schedule}, due {minutes(t.dueMinutes)}</Td>
              <Td className="text-ink-700">{t.assigneeName ?? t.queue ?? "The queue"}</Td>
              <Td className="text-ink-700">{t.nextOn ? formatDay(t.nextOn, tz) : <Chip tone="neutral">Paused</Chip>}</Td>
              <Td>
                {writes ? (
                  <div className="flex flex-col items-start gap-1">
                    <ActionForm action={setTemplateActive} submit={t.active ? "Pause" : "Resume"} tone="quiet"
                                hidden={{ id: t.id, active: t.active ? "0" : "1" }} className="flex items-center gap-2" />
                    <ActionForm action={setTemplateSkipHolidays}
                                submit={t.skipHolidays ? "Raise on holidays too" : "Skip holidays"}
                                tone="quiet" hidden={{ id: t.id, skipHolidays: t.skipHolidays ? "0" : "1" }}
                                className="flex items-center gap-2" />
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {writes && (
        <section aria-label="Add a recurring task" className="mt-10">
          <h2 className="text-base font-semibold">Add a recurring task</h2>
          <ActionForm action={addTemplate} submit="Add recurring task" className="mt-3 space-y-3">
            <TextField label="What needs doing" name="title" required maxLength={300} />
            <TextArea label="More detail" name="body" rows={2} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="How often" name="frequency" options={[
                { value: "daily", label: "Every day" },
                { value: "weekdays", label: "Every weekday, Monday to Friday" },
                { value: "weekly", label: "Every week" },
                { value: "every_other_week", label: "Every other week" },
                { value: "every_n_weeks", label: "Every few weeks" },
                { value: "chosen_weekdays", label: "On the days I tick" },
                { value: "monthly", label: "Every month, on a date" },
                { value: "nth_weekday_of_month", label: "The first, second, third or fourth one of every month" },
                { value: "last_weekday_of_month", label: "The last one of every month" },
              ]} />
              <Select label="Day of the week (weekly, every few weeks, one of the month)" name="weekday" defaultValue="1"
                      options={WEEK_ORDER.map((i) => ({ value: String(i), label: WEEKDAYS[i]! }))} />
              <TextField label="Date of the month (every month, on a date)" name="monthDay" type="number" min={1} max={31} defaultValue="1" />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="Which one in the month (first to fourth)" name="monthWeek" defaultValue="1" options={[
                { value: "1", label: "The first" },
                { value: "2", label: "The second" },
                { value: "3", label: "The third" },
                { value: "4", label: "The fourth" },
              ]} />
              <TextField label="How many weeks apart (every few weeks)" name="intervalWeeks" type="number" min={2} max={52} defaultValue="3" />
              <fieldset className="text-sm">
                <legend className="text-ink-700">Which days (on the days I tick)</legend>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {WEEK_ORDER.map((i) => (
                    <label key={i} className="flex items-center gap-1">
                      <input type="checkbox" name="daysOfWeek" value={String(i)} />
                      {WEEKDAYS[i]}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Due at" name="dueTime" type="time" defaultValue="17:00" />
              <TextField label="Starting" name="startsOn" type="date" defaultValue={todayIn(tz)} />
              <Select label="Priority" name="priority" defaultValue="normal"
                      options={Object.entries(TASK_PRIORITY).map(([value, l]) => ({ value, label: l }))} />
            </div>
            <p className="text-xs text-ink-500">
              Every other week and every few weeks start with the first of that day of the week on or after
              the starting day, then every second (or third, or however many) one after it. The last one of
              every month is the last Friday, say, whether that is the fourth or the fifth.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="skipHolidays" value="yes" />
              Not on a holiday: skip a day your holiday list says you are closed
            </label>
            <Select label="For" name="assigneeUserId"
                    options={[{ value: "", label: "Nobody yet (the queue)" }, ...people.map((p) => ({ value: p.userId, label: p.name }))]} />
            <TextArea label="Checklist, one item a line" name="checklist" rows={3} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
