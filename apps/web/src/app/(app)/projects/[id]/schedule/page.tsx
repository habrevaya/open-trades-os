import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projectSchedule, NotFoundError } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { ProjectTabs } from "../../ProjectTabs";
import { Timeline } from "../../Timeline";
import { PhaseDatesForm } from "../../ChangeOrderForms";
import { PHASE_STATUS } from "../../ProjectView";

export const dynamic = "force-dynamic";

/**
 * THE SCHEDULE
 *
 * The phases on a timeline with what each waits for, the critical path in
 * red (with the word as well as the colour), and who is booked on each
 * phase, read from the visits on its jobs. The sentence at the top is
 * core's: when the job finishes and how many phases decide that.
 */
export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const schedule = await projectSchedule.schedule(ctx, { projectId: id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const editable = can(user.actor, "job:write");
  const today = time.dateIn(new Date(), user.organizationTimezone);
  const names = new Map(schedule.phases.map((p) => [p.id, p.name]));
  const people = (p: (typeof schedule.phases)[number]) => [
    ...p.booked.technicians.map((t) => t.name), ...p.booked.crews.map((c) => c.name),
  ].join(", ");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <Crumb href={`/projects/${id}`}>{schedule.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Schedule</h1>
      <ProjectTabs projectId={id} current="schedule" money={can(user.actor, "invoice:read")} />

      <p className="mt-4 text-sm text-ink-700">{schedule.statement}</p>
      {schedule.targetCompletionOn && schedule.finish && schedule.finish > schedule.targetCompletionOn && (
        <p className="mt-2 rounded-md border border-amber-700 bg-amber-tint p-3 text-sm text-ink-900">
          The plan finishes on {schedule.finish}, after the {schedule.targetCompletionOn} the project is due.
        </p>
      )}

      <Timeline
        projectId={id}
        today={today}
        editable={editable}
        phases={schedule.phases.map((p) => ({
          id: p.id, sequence: p.sequence, name: p.name, status: p.status, dependsOnPhaseId: p.dependsOnPhaseId,
          startsOn: p.startsOn, endsOn: p.endsOn, floatDays: p.floatDays, critical: p.critical,
          overlapsPredecessor: p.overlapsPredecessor, people: people(p),
        }))}
      />

      <h2 className="mt-8 text-base font-semibold">Phases and who is booked</h2>
      <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
        {schedule.phases.map((phase) => (
          <li key={phase.id} className="bg-canvas p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{phase.sequence}. {phase.name}</span>
              <Chip tone={phase.status === "complete" ? "success" : phase.status === "blocked" ? "warning" : "neutral"}>
                {PHASE_STATUS[phase.status] ?? phase.status}
              </Chip>
              {phase.critical && <Chip tone="danger">Critical path</Chip>}
              {phase.overlapsPredecessor && <Chip tone="warning">Starts before {names.get(phase.dependsOnPhaseId ?? "") ?? "the phase it waits for"} ends</Chip>}
            </div>
            <p className="mt-1 text-sm text-ink-700">
              {phase.dependsOnPhaseId ? `Waits for ${names.get(phase.dependsOnPhaseId) ?? "another phase"}. ` : ""}
              {phase.booked.technicians.length + phase.booked.crews.length === 0
                ? "Nobody is booked yet."
                : `Booked: ${people(phase)}.`}
              {phase.booked.unassignedVisits > 0 ? ` ${phase.booked.unassignedVisits} ${phase.booked.unassignedVisits === 1 ? "visit has" : "visits have"} nobody on it.` : ""}
            </p>
            {editable && phase.status !== "complete" && (
              <PhaseDatesForm submit="Set dates" hidden={{ projectId: id, phaseId: phase.id }} className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-xs text-ink-700">Starts
                  <input type="date" name="startsOn" defaultValue={phase.startsOn ?? ""} className="ml-1 h-8 rounded border border-steel-300 px-2 text-sm" />
                </label>
                <label className="text-xs text-ink-700">Ends
                  <input type="date" name="endsOn" defaultValue={phase.endsOn ?? ""} className="ml-1 h-8 rounded border border-steel-300 px-2 text-sm" />
                </label>
              </PhaseDatesForm>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
