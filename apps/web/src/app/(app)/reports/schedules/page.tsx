import { notFound } from "next/navigation";
import { Chip } from "@opentradesos/ui";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { deliverySchedules } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader } from "@/components/Table";
import { formatDay, formatIn } from "@/lib/dates";
import { enumText } from "@/lib/labels";
import { deleteSchedule, sendNow, setPaused } from "./actions";

export const dynamic = "force-dynamic";

/** A delivery's outcome in a word somebody reads, and how worried to be about it. */
const OUTCOME: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  queued: { label: "Went out", tone: "success" },
  partly_queued: { label: "Went to some", tone: "warning" },
  refused: { label: "Went to nobody", tone: "danger" },
  failed: { label: "Did not run", tone: "danger" },
};

/**
 * REPORTS THAT ARRIVE ON THEIR OWN
 *
 * Every schedule, and the one question each row has to answer: did the last
 * one go, and to whom. A report that "just stopped arriving" is the complaint
 * this screen exists for, so the last delivery is on the row with each
 * recipient's outcome, the message's own status beside it, and the reason
 * when there was one: left the company, no longer allowed to see it, asked
 * not to be emailed, no email connected.
 *
 * Pause is beside every row and needs no confirmation, because it loses
 * nothing: a paused schedule comes back on its clock with its history.
 */
export default async function SchedulesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "report:read")) notFound();

  const schedules = await deliverySchedules.listReportSchedules(ctx);
  const builds = can(user.actor, "report:build");
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <a href="/reports" className="text-sm text-ink-500 hover:underline">Reports</a>
      <div className="mt-2">
        <PageHeader
          title="Schedules"
          action={builds ? (
            <a href="/reports/schedules/new"
               className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white hover:bg-ink-700">
              Schedule a report
            </a>
          ) : null}
        />
      </div>
      <p className="mt-1 text-sm text-ink-700">
        Reports emailed on their own, with a spreadsheet of every row. Each one runs as the person who set it
        up and only goes to people who could open it themselves.
      </p>

      {schedules.length === 0 ? (
        <Empty title="Nothing is scheduled yet">
          {builds
            ? "Open a report and press Email on a schedule, or start here."
            : "Somebody who can build reports can set one up."}
        </Empty>
      ) : (
        <ul className="mt-6 space-y-4">
          {schedules.map((schedule) => {
            const last = schedule.lastDelivery;
            const outcome = last ? OUTCOME[last.status] : undefined;
            return (
              <li key={schedule.id} className="rounded-md border border-steel-200 bg-canvas p-4"
                  aria-label={schedule.name}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    {schedule.reportPath ? (
                      <a href={schedule.reportPath} className="font-medium hover:underline">{schedule.name}</a>
                    ) : (
                      <span className="font-medium">{schedule.name}</span>
                    )}
                    <p className="mt-0.5 text-sm text-ink-700">
                      {schedule.cadenceText}. {schedule.periodText}.
                    </p>
                    <p className="mt-0.5 text-sm text-ink-500">
                      To {[...schedule.people.map((p) => p.name), ...schedule.addresses].join(", ") || "nobody"}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    {schedule.paused ? (
                      <Chip tone="warning">Paused</Chip>
                    ) : schedule.nextRunAt ? (
                      <span className="text-ink-700">Next: {formatIn(schedule.nextRunAt, zone)}</span>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 border-t border-steel-200 pt-3 text-sm">
                  {last ? (
                    <>
                      <p>
                        <span className="text-ink-500">Last: </span>
                        {formatIn(last.at, zone)}
                        {outcome ? <> <Chip tone={outcome.tone}>{outcome.label}</Chip></> : null}
                        {last.periodFrom && last.periodTo ? (
                          <span className="text-ink-500">
                            {" "}covering {formatDay(last.periodFrom, zone)} up to {formatDay(last.periodTo, zone)}
                          </span>
                        ) : null}
                        {last.rowCount !== null ? <span className="text-ink-500">, {last.rowCount} rows</span> : null}
                      </p>
                      {last.error ? <p className="mt-1 text-red-600">{last.error}</p> : null}
                      {last.recipients.length > 0 && (
                        <ul className="mt-1 space-y-0.5" aria-label={`Who the last ${schedule.name} went to`}>
                          {last.recipients.map((r, index) => (
                            <li key={`${r.address}-${index}`} className="text-ink-700">
                              {r.address || "Somebody who has left"}:{" "}
                              {r.refused
                                ? <span className="text-red-600">not sent, {r.refused}</span>
                                : <span>{enumText(r.messageStatus ?? "queued")}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="text-ink-500">Nothing sent yet.</p>
                  )}
                  {schedule.lastError && schedule.lastError !== last?.error ? (
                    <p className="mt-1 text-red-600">{schedule.lastError}</p>
                  ) : null}
                </div>

                {builds && (
                  <div className="mt-3 flex flex-wrap items-start gap-3">
                    <ActionForm
                      action={setPaused} tone="quiet" className="flex items-center gap-2"
                      submit={schedule.paused ? `Resume ${schedule.name}` : `Pause ${schedule.name}`}
                      hidden={{ id: schedule.id, paused: schedule.paused ? "false" : "true" }}
                    />
                    {/*
                      Beside Pause because it is the other thing somebody
                      does to a schedule without changing it: see what it
                      sends, or send it again for the accountant who lost it.
                    */}
                    <ActionForm
                      action={sendNow} tone="quiet" className="flex flex-wrap items-center gap-2"
                      submit={`Send ${schedule.name} now`}
                      hidden={{ id: schedule.id }}
                    />
                    <a href={`/reports/schedules/${schedule.id}`}
                       className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                      Change
                    </a>
                    <ActionForm
                      action={deleteSchedule} tone="danger" className="flex items-center gap-2"
                      submit={`Stop ${schedule.name} for good`}
                      hidden={{ id: schedule.id }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
