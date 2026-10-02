import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports, deliverySchedules, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { ScheduleForm, reportOptions } from "../ScheduleForm";
import { updateSchedule } from "../actions";

export const dynamic = "force-dynamic";

/** Change a schedule. Whoever saves it becomes whose authority it runs under. */
export default async function EditSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "report:build")) notFound();
  const { id } = await params;

  const schedule = await deliverySchedules.getReportSchedule(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const options = reportOptions(reports.builtIn(ctx), await reports.list(ctx));
  const people = await deliverySchedules.recipientChoices(ctx);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/reports/schedules">Schedules</Crumb>
      <div className="mt-2">
        <PageHeader title={`Change "${schedule.name}"`} />
      </div>
      <p className="mt-1 text-sm text-ink-700">
        Saving makes it run as you from now on, with what you can see.
      </p>
      <ScheduleForm
        action={updateSchedule} submit="Save changes" hidden={{ id }}
        reports={options} people={people} timezone={user.organizationTimezone}
        defaults={{
          report: schedule.builtInReport ? `builtIn:${schedule.builtInReport}` : `saved:${schedule.reportId}`,
          name: schedule.name,
          frequency: schedule.frequency,
          weekdays: schedule.weekdays,
          dayOfMonth: schedule.dayOfMonth,
          time: schedule.timeOfDay,
          period: schedule.period,
          userIds: schedule.recipientUserIds,
          addresses: schedule.externalAddresses,
        }}
      />
    </div>
  );
}
