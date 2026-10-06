import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { crews, safety, safetyTalks } from "@opentradesos/api/services";
import { can, taskRules } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay, todayIn } from "@/lib/dates";
import { addSchedule, setScheduleActive } from "../talk-actions";

export const dynamic = "force-dynamic";

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * TALKS ON A SCHEDULE
 *
 * A topic from the library for a crew or one person, on the same schedules a
 * recurring task uses. On its day the talk is raised with the crew's members
 * as they are that day, and each signs from their own phone. Paused and
 * resumed here.
 */
export default async function TalkSchedulesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const tz = user.organizationTimezone;
  if (!can(user.actor, "safety:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Talks on a schedule" />
        <Empty title="Safety records are not part of your access">Somebody who runs safety can show you the schedule.</Empty>
      </div>
    );
  }
  const schedules = await safetyTalks.listSchedules(ctx);
  const writes = can(user.actor, "safety:write");
  const topics = writes ? await safetyTalks.listTopics(ctx) : [];
  const people = writes ? await safety.people(ctx) : [];
  const crewList = writes && can(user.actor, "visit:read") ? (await crews.list(ctx)).filter((c) => c.active) : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/compliance/safety">Toolbox talks</Crumb>
      <PageHeader title="Talks on a schedule" count={schedules.filter((s) => s.active).length} />

      {schedules.length === 0 ? (
        <Empty title="Nothing on a schedule">Put a topic from your library on one below.</Empty>
      ) : (
        <Table label="Talks on a schedule" head={<><Th>Topic</Th><Th>For</Th><Th>When</Th><Th>Next</Th><Th>{""}</Th></>}>
          {schedules.map((s) => (
            <tr key={s.id}>
              <Td>
                <span className="font-medium">{s.topicTitle}</span>
                {s.topicRetired ? <Chip tone="neutral" className="ml-2">Topic retired</Chip> : null}
                {!s.active ? <Chip tone="neutral" className="ml-2">Paused</Chip> : null}
              </Td>
              <Td>{s.who}</Td>
              <Td className="text-ink-700">{s.schedule}, at {clock(s.heldMinutes)}{s.location ? `, ${s.location}` : ""}</Td>
              <Td>{s.nextOn ? formatDay(s.nextOn, tz) : "None"}</Td>
              <Td>
                {writes ? (
                  <ActionForm action={setScheduleActive} tone="quiet" className="flex items-center gap-2"
                              submit={s.active ? "Pause" : "Resume"} hidden={{ id: s.id, active: s.active ? "no" : "yes" }} />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section aria-label="Put a talk on a schedule" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">Put a talk on a schedule</h2>
          {topics.length === 0 ? (
            <p className="mt-2 text-sm text-ink-700">
              Add a topic to <a href="/compliance/safety/topics" className="underline underline-offset-4">your library</a> first.
            </p>
          ) : (
            <ActionForm action={addSchedule} submit="Put it on the schedule" className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Select label="Topic" name="topicId" options={topics.map((t) => ({ value: t.id, label: t.title }))} />
                <Select label="For" name="who" options={[
                  ...crewList.map((c) => ({ value: `crew:${c.id}`, label: `${c.name} (crew)` })),
                  ...people.map((p) => ({ value: `tech:${p.value}`, label: p.label })),
                ]} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Select label="How often" name="frequency" defaultValue="weekly" options={[
                  { value: "daily", label: "Every day" },
                  { value: "weekdays", label: "Every weekday, Monday to Friday" },
                  { value: "weekly", label: "Every week" },
                  { value: "every_other_week", label: "Every other week" },
                  { value: "monthly", label: "Every month, on a date" },
                  { value: "last_weekday_of_month", label: "The last one of every month" },
                ]} />
                <Select label="Day of the week (weekly, every other week, last of the month)" name="weekday" defaultValue="1"
                        options={taskRules.WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
                <TextField label="Date of the month (every month, on a date)" name="monthDay" type="number" min={1} max={31} defaultValue="1" />
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <TextField label="At" name="heldTime" type="time" defaultValue="07:00" />
                <TextField label="Starting" name="startsOn" type="date" defaultValue={todayIn(tz)} />
                <TextField label="Where (optional)" name="location" maxLength={300} placeholder="The shop" />
                <TextField label="Led by (optional)" name="ledBy" maxLength={200} />
              </div>
            </ActionForm>
          )}
        </section>
      ) : null}
    </div>
  );
}
