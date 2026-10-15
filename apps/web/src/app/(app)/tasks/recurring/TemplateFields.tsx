import type { taskRules } from "@opentradesos/api/services";
import { TextField, TextArea, Select } from "@/components/ActionForm";
import { TASK_PRIORITY } from "@/lib/labels";

/**
 * THE BOXES OF A RECURRING TASK
 *
 * One set of boxes, in one set of words, for adding a recurring task and for
 * changing one, so the two cannot drift apart: a rule the add form explains
 * is explained the same way on the change form. Given a template, the boxes
 * start with what it holds; given none, with what a new one starts with.
 */
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first on the form, because a working week starts on a Monday. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function TemplateFields({
  template, people, today,
}: {
  template?: taskRules.TemplateView;
  people: { userId: string; name: string }[];
  today: string;
}) {
  return (
    <>
      <TextField label="What needs doing" name="title" required maxLength={300} defaultValue={template?.title ?? ""} />
      <TextArea label="More detail" name="body" rows={2} defaultValue={template?.body ?? ""} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="How often" name="frequency" defaultValue={template?.frequency ?? "daily"} options={[
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
        <Select label="Day of the week (weekly, every few weeks, one of the month)" name="weekday"
                defaultValue={String(template?.weekday ?? 1)}
                options={WEEK_ORDER.map((i) => ({ value: String(i), label: WEEKDAYS[i]! }))} />
        <TextField label="Date of the month (every month, on a date)" name="monthDay" type="number" min={1} max={31}
                   defaultValue={String(template?.monthDay ?? 1)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Which one in the month (first to fourth)" name="monthWeek" defaultValue={String(template?.monthWeek ?? 1)} options={[
          { value: "1", label: "The first" },
          { value: "2", label: "The second" },
          { value: "3", label: "The third" },
          { value: "4", label: "The fourth" },
        ]} />
        <TextField label="How many weeks apart (every few weeks)" name="intervalWeeks" type="number" min={2} max={52}
                   defaultValue={String(template?.intervalWeeks ?? 3)} />
        <fieldset className="text-sm">
          <legend className="text-ink-700">Which days (on the days I tick)</legend>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {WEEK_ORDER.map((i) => (
              <label key={i} className="flex items-center gap-1">
                <input type="checkbox" name="daysOfWeek" value={String(i)} defaultChecked={template?.daysOfWeek?.includes(i) ?? false} />
                {WEEKDAYS[i]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Due at" name="dueTime" type="time" defaultValue={clock(template?.dueMinutes ?? 17 * 60)} />
        <TextField label="Starting" name="startsOn" type="date" defaultValue={template?.startsOn ?? today} />
        <Select label="Priority" name="priority" defaultValue={template?.priority ?? "normal"}
                options={Object.entries(TASK_PRIORITY).map(([value, l]) => ({ value, label: l }))} />
      </div>
      <p className="text-xs text-ink-500">
        Every other week and every few weeks start with the first of that day of the week on or after
        the starting day, then every second (or third, or however many) one after it. The last one of
        every month is the last Friday, say, whether that is the fourth or the fifth.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="skipHolidays" value="yes" defaultChecked={template?.skipHolidays ?? false} />
        Not on a holiday: skip a day your holiday list says you are closed
      </label>
      <Select label="For" name="assigneeUserId" defaultValue={template?.assigneeUserId ?? ""}
              options={[
                { value: "", label: "Nobody yet (the queue)" },
                ...people.map((p) => ({ value: p.userId, label: p.name })),
                // Kept in the list so saving does not quietly hand the work to nobody: the service says why not.
                ...(template?.assigneeUserId && !people.some((p) => p.userId === template.assigneeUserId)
                  ? [{ value: template.assigneeUserId, label: `${template.assigneeName ?? "Someone"} (no longer works here)` }]
                  : []),
              ]} />
      <TextArea label="Checklist, one item a line" name="checklist" rows={3} defaultValue={(template?.checklist ?? []).join("\n")} />
    </>
  );
}
