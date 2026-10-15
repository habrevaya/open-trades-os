import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { serviceReports, jobs } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { saveRequired } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → SERVICE REPORTS
 *
 * What a technician must fill in on each kind of report. A template's fields
 * came from the trade pack and could be changed only through the API, so "the
 * regulated fields the operator's configuration requires" (pest control's
 * application record completeness) was a configuration nobody could see or
 * set. Here every template lists its fields, says which a regulator asks for,
 * and ticks the ones the company requires.
 *
 * Saving bumps the template's version, and each report keeps the list it was
 * required to capture when it was written, so a change today does not judge
 * last spring's visits against this spring's list. Read with
 * `servicereport:read`; saved with `servicereport:write`, as
 * `PATCH /v1/service-report-templates/{id}` is.
 */
export default async function ServiceReportSettingsPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "servicereport:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Service reports" />
        <Empty title="Not shown to your role">Service report templates need the permission to read service reports.</Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const templates = await serviceReports.listTemplates(ctx);
  const types = can(user.actor, "job:read") ? (await jobs.listTypes(ctx, { includeInactive: true })).data : [];
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const writes = can(user.actor, "servicereport:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Service reports" />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        What a technician must fill in before a report is complete. Fields marked &quot;Regulator asks for it&quot; are the
        application record a state can ask to see. A change counts for reports written from now on; each report keeps the
        list it was held to.
      </p>
      {templates.length === 0 ? (
        <Empty title="No report templates">A trade pack adds them when it is applied.</Empty>
      ) : templates.map((template) => (
        <section key={template.id} aria-label={template.name} className="mt-8">
          <h2 className="text-base font-semibold">{template.name}</h2>
          <p className="text-xs text-ink-500">
            {template.jobTypeId ? `For ${typeName.get(template.jobTypeId) ?? "one kind of job"}` : "Not tied to a kind of job"}, version {template.version}
          </p>
          <ActionForm action={saveRequired} submit="Save what is required" tone="quiet" hidden={{ templateId: template.id }}
                      className="mt-3 space-y-3">
            <ul className="divide-y divide-steel-200 rounded-md border border-steel-200">
              {template.fields.map((f) => (
                <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="required" value={f.key} defaultChecked={f.required === true}
                           disabled={!writes} className="h-4 w-4" />
                    <span>{f.label}</span>
                  </label>
                  {f.regulated ? <Chip tone="warning">Regulator asks for it</Chip> : null}
                </li>
              ))}
            </ul>
          </ActionForm>
        </section>
      ))}
    </div>
  );
}
