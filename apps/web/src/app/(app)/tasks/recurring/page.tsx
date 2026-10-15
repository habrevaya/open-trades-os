import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { taskRules } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { TASK_PRIORITY, label } from "@/lib/labels";
import { formatDay, todayIn } from "@/lib/dates";
import { addTemplate, setTemplateActive, setTemplateSkipHolidays } from "../rule-actions";
import { TemplateFields } from "./TemplateFields";

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
                    <a href={`/tasks/recurring/${t.id}`} aria-label={`Change ${t.title}`}
                       className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">Change</a>
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
            <TemplateFields people={people} today={todayIn(tz)} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
