import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reports } from "@opentradesos/api/services";
import { can, type reporting } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { queryFor } from "@/lib/report-params";
import { SavedReportActions } from "./SavedReportActions";

export const dynamic = "force-dynamic";

/**
 * REPORTS
 *
 * Two lists and a builder. The built-in reports are first because a reporting
 * feature that opens on an empty builder is a reporting feature nobody uses:
 * the blank page is where it dies, and "here are eight answers, edit one" is
 * a much shorter path to the ninth.
 *
 * Both lists are filtered by what the reader holds, so a dispatcher and an
 * owner see different reports rather than the same list with half of it
 * erroring when clicked.
 */
export default async function ReportsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "report:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Reports" />
        <Empty title="Reports are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const builtIn = reports.builtIn(ctx);
  const saved = await reports.list(ctx);
  const builds = can(user.actor, "report:build");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Reports"
        action={builds ? (
          <a
            href="/reports/new"
            className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white hover:bg-ink-700"
          >
            Build a report
          </a>
        ) : null}
      />

      <h2 className="mt-8 text-sm font-medium text-ink-700">Out of the box</h2>
      {builtIn.length === 0 ? (
        <Empty title="None of these are open to you">
          Each built-in report needs the permission for the records it reads.
        </Empty>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {builtIn.map((report) => (
            <li key={report.slug} className="rounded-md border border-steel-200 bg-canvas p-4">
              <a href={`/reports/built-in/${report.slug}`} className="font-medium hover:underline">
                {report.name}
              </a>
              {/*
                The question, not a description of the report. "What did we
                invoice, month by month" tells somebody whether to click;
                "aggregates invoice totals by month" does not.
              */}
              <p className="mt-1 text-sm text-ink-700">{report.question}</p>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-10 text-sm font-medium text-ink-700">Yours</h2>
      {saved.length === 0 ? (
        <Empty title="No saved reports yet">
          {builds
            ? "Open a built-in report and save a copy, or start from scratch."
            : "Somebody who can build reports can save one here for everybody."}
        </Empty>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {saved.map((report) => (
            <li key={report.id} className="flex flex-wrap items-baseline justify-between gap-3 bg-canvas p-4">
              <div>
                <a href={`/reports/saved/${report.id}`} className="font-medium hover:underline">
                  {report.name}
                </a>
                {report.description ? (
                  <p className="mt-1 text-sm text-ink-700">{report.description}</p>
                ) : null}
              </div>
              {builds ? (
                <div className="flex items-center gap-3 text-sm">
                  <a
                    href={`/reports/new?${queryFor(report.definition as unknown as reporting.ReportDefinition)}`}
                    className="text-ink-700 hover:underline"
                  >
                    Edit a copy
                  </a>
                  <SavedReportActions id={report.id} name={report.name} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
