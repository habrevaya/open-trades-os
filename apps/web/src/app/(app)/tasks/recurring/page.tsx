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
import { addTemplate, setTemplateActive } from "../rule-actions";

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
        <Empty title="Nothing recurs yet">Add the work that comes round every day, week or month, and it lands in the queue on the day.</Empty>
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
                  <ActionForm action={setTemplateActive} submit={t.active ? "Pause" : "Resume"} tone="quiet"
                              hidden={{ id: t.id, active: t.active ? "0" : "1" }} className="flex items-center gap-2" />
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
                { value: "weekly", label: "Every week" },
                { value: "monthly", label: "Every month" },
              ]} />
              <Select label="On (weekly)" name="weekday" defaultValue="1"
                      options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
              <TextField label="Day of the month (monthly)" name="monthDay" type="number" min={1} max={31} defaultValue="1" />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Due at" name="dueTime" type="time" defaultValue="17:00" />
              <TextField label="Starting" name="startsOn" type="date" defaultValue={todayIn(tz)} />
              <Select label="Priority" name="priority" defaultValue="normal"
                      options={Object.entries(TASK_PRIORITY).map(([value, l]) => ({ value, label: l }))} />
            </div>
            <Select label="For" name="assigneeUserId"
                    options={[{ value: "", label: "Nobody yet (the queue)" }, ...people.map((p) => ({ value: p.userId, label: p.name }))]} />
            <TextArea label="Checklist, one item a line" name="checklist" rows={3} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
