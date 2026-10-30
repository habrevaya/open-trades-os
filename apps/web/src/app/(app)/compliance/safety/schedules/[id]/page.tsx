import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { crews, safety, safetyTalks } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, PageHeader } from "@/components/Table";
import { formatDay } from "@/lib/dates";
import { changeSchedule } from "../../talk-actions";

export const dynamic = "force-dynamic";

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * CHANGE A SCHEDULED TALK
 *
 * The topic, who it is for, the time, where, who leads it, and whether it
 * skips holidays. It applies from the next talk raised; a talk already raised
 * keeps its words, its sheet, its time and its place. The days it comes round
 * on are not changed here: pause this one and put the talk on a new schedule.
 */
export default async function ChangeSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const tz = user.organizationTimezone;
  if (!can(user.actor, "safety:write")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="Change a scheduled talk" />
        <Empty title="Changing a schedule is not part of your access">Somebody who runs safety can change it.</Empty>
      </div>
    );
  }
  const schedule = (await safetyTalks.listSchedules(ctx)).find((s) => s.id === id);
  if (!schedule) notFound();
  const topics = (await safetyTalks.listTopics(ctx)).filter((t) => !t.retired || t.id === schedule.topicId);
  const people = await safety.people(ctx);
  const crewList = can(user.actor, "visit:read") ? (await crews.list(ctx)).filter((c) => c.active) : [];
  const audiences = await safetyTalks.audienceChoices(ctx);

  /** The "For" choice this schedule has now, in the same words the form posts. */
  const current = schedule.audience === "crew" ? `crew:${schedule.crewId}`
    : schedule.audience === "person" ? `tech:${schedule.technicianId}`
      : schedule.audience === "role" ? (schedule.roleId ? `role:custom:${schedule.roleId}` : `role:preset:${schedule.role}`)
        : schedule.audience === "branch" ? `branch:${schedule.branchId}` : "everybody";
  const choices = [
    { value: "everybody", label: "Everybody in the field" },
    ...audiences.branches.map((b) => ({ value: `branch:${b.id}`, label: `Everybody in ${b.name}` })),
    ...audiences.roles.map((r) => ({ value: `role:${r.value}`, label: r.own ? `Everybody with your ${r.label} role` : `Everybody with the ${r.label} role` })),
    ...crewList.map((c) => ({ value: `crew:${c.id}`, label: `${c.name} (crew)` })),
    ...people.map((p) => ({ value: `tech:${p.value}`, label: p.label })),
  ];
  /** Kept in the list when its audience is not on offer any more, so saving does not quietly change who it is for. */
  const withCurrent = choices.some((c) => c.value === current) ? choices : [{ value: current, label: `${schedule.who} (as it is now)` }, ...choices];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/compliance/safety/schedules">Talks on a schedule</Crumb>
      <PageHeader title={`Change: ${schedule.topicTitle}`} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {schedule.schedule}. {schedule.nextOn ? `The next talk is raised for ${formatDay(schedule.nextOn, tz)}.` : "Nothing is raised while it is paused."}{" "}
        What you change here applies from the next talk raised. A talk already raised keeps its words, the people on its
        sheet, its time and its place. To change which days it comes round on, pause this one and put the talk on a new schedule.
      </p>
      <ActionForm action={changeSchedule} submit="Save changes" hidden={{ id: schedule.id }} className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Topic" name="topicId" defaultValue={schedule.topicId}
                  options={topics.map((t) => ({ value: t.id, label: t.retired ? `${t.title} (retired)` : t.title }))} />
          <Select label="For" name="who" defaultValue={current} options={withCurrent} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="At" name="heldTime" type="time" defaultValue={clock(schedule.heldMinutes)} />
          <TextField label="Where (optional)" name="location" maxLength={300} defaultValue={schedule.location ?? ""} />
          <TextField label="Led by (optional)" name="ledBy" maxLength={200} defaultValue={schedule.ledBy ?? ""} />
        </div>
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" name="skipHolidays" defaultChecked={schedule.skipHolidays} className="mt-0.5 h-4 w-4 rounded border-steel-300" />
          <span>Skip the days the company is closed (your holidays). The talk is not moved to another day.</span>
        </label>
      </ActionForm>
    </div>
  );
}
