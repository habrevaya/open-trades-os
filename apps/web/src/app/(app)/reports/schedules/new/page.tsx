import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports, deliverySchedules } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { ScheduleForm, reportOptions } from "../ScheduleForm";
import { createSchedule } from "../actions";

export const dynamic = "force-dynamic";

/**
 * A NEW SCHEDULE, usually opened from the Schedule button on a report, which
 * names the report in the URL so the form starts on it.
 */
export default async function NewSchedulePage({ searchParams }: {
  searchParams: Promise<{ report?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "report:build")) notFound();
  const { report } = await searchParams;

  const options = reportOptions(reports.builtIn(ctx), await reports.list(ctx));
  const people = await deliverySchedules.recipientChoices(ctx);
  const chosen = options.find((o) => o.value === report)?.value;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/reports/schedules">Schedules</Crumb>
      <div className="mt-2">
        <PageHeader title="Email a report on a schedule" />
      </div>
      <p className="mt-1 text-sm text-ink-700">
        A summary in the email and every row in a spreadsheet attached. The first one goes at the next time
        you pick, not now.
      </p>
      <ScheduleForm
        action={createSchedule} submit="Schedule it"
        reports={options} people={people} timezone={user.organizationTimezone}
        defaults={{ ...(chosen ? { report: chosen } : {}), userIds: [user.userId] }}
      />
    </div>
  );
}
