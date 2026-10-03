import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects, projectApplications, NotFoundError } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { Empty } from "@/components/Table";
import { TextField } from "@/components/ActionForm";
import { ProjectTabs } from "../../ProjectTabs";
import { ApplicationForm } from "../../ChangeOrderForms";

export const dynamic = "force-dynamic";

/**
 * APPLICATIONS FOR PAYMENT
 *
 * Progress billing period by period: each application states the whole
 * position (the schedule of values, work this period and to date, stored
 * materials, retainage held and released) and becomes one invoice for what
 * is due now. The list is the project's billing history in the shape a
 * certifier keeps it.
 */
export default async function ApplicationsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "invoice:read")) notFound();
  const project = await projects.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const list = await projectApplications.list(ctx, { projectId: id });
  const draft = list.find((a) => a.status === "draft");
  const today = time.dateIn(new Date(), user.organizationTimezone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href={`/projects/${id}`}>{project.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Applications for payment</h1>
      <ProjectTabs projectId={id} current="applications" money />

      {project.draws.length > 0 ? (
        <Empty title="This project is billed by draws">
          A project is billed one way, by draws or by applications for payment, so the same work is never billed
          twice. Its draws are on the overview.
        </Empty>
      ) : list.length === 0 ? (
        <Empty title="No applications yet">
          Each application lists the schedule of values (the phases with a billing value, and agreed change orders),
          what was done this period, what is stored on site and the retainage held, and becomes one invoice.
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {list.map((application) => (
            <li key={application.id}>
              <Link href={`/projects/${id}/applications/${application.id}`} className="flex flex-wrap items-center gap-3 bg-canvas p-4 hover:bg-steel-100">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">Application {application.number}</span>
                  <span className="block text-sm text-ink-500">
                    {application.periodFrom ? `${application.periodFrom} to ` : "Up to "}{application.periodTo}
                  </span>
                </span>
                {application.currentPaymentDue && (
                  <span className="text-sm tabular-nums">Due <Money value={application.currentPaymentDue} /></span>
                )}
                <Chip tone={application.status === "invoiced" ? "success" : "info"}>
                  {application.status === "invoiced" ? "Invoiced" : "Draft"}
                </Chip>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {can(user.actor, "invoice:write") && project.draws.length === 0 && !draft && (
        <section className="mt-8 max-w-xl" aria-label="Start an application">
          <h2 className="text-base font-semibold">Start the next application</h2>
          <p className="mt-1 text-sm text-ink-500">
            The period runs on from the last one, and retainage carries over from it
            {project.retainageRate ? `, or starts at the project's ${Number(project.retainageRate) * 100}%` : ""}.
          </p>
          <ApplicationForm submit="Start application" hidden={{ op: "create", projectId: id }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Period ends" name="periodTo" type="date" required defaultValue={today} />
              <TextField label="Period starts (optional)" name="periodFrom" type="date" />
              <TextField label="Retainage on work, %" name="retainagePercent" inputMode="decimal" placeholder="Carried over" />
              <TextField label="Retainage on stored materials, %" name="storedRetainagePercent" inputMode="decimal" placeholder="Carried over" />
            </div>
          </ApplicationForm>
        </section>
      )}
    </div>
  );
}
