import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, serviceReports, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { Empty, Table, Td, Th } from "@/components/Table";
import { HoldPanel } from "@/components/HoldPanel";
import { formatIn } from "@/lib/dates";
import { REPORT_STATUS, REPORT_TONE } from "../labels";
import { actOnServiceReport } from "../actions";

export const dynamic = "force-dynamic";

/** A captured value as somebody reads it. */
function shown(value: string | number | boolean | null, unit: string | null): string {
  if (value === null) return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = typeof value === "string" && /^-?\d+\.\d+$/.test(value) ? String(Number(value)) : String(value);
  return unit ? `${text} ${unit}` : text;
}

/**
 * ONE SERVICE REPORT
 *
 * Everything recorded at the visit (`GET /v1/service-reports/{id}`), the
 * office's own words on it, publishing it to the customer and taking it back,
 * and its retention hold. The technician's notes are shown and never edited:
 * they are what the person in the building wrote. Each button says what the
 * customer will and will not see, because publishing hands them a document.
 */
export default async function ServiceReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  const report = await serviceReports.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const customer = can(user.actor, "customer:read")
    ? await customers.get(ctx, { id: report.customerId }).catch(() => null)
    : null;
  const writes = can(user.actor, "servicereport:write");
  const publishes = can(user.actor, "servicereport:publish");
  const published = report.status === "published";
  const outOfRange = report.fields.filter((f) => f.outOfRange).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/service-reports">Service reports</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Service report</h1>
        <Chip tone={REPORT_TONE[report.status]}>{REPORT_STATUS[report.status]}</Chip>
      </div>
      <Facts>
        <Fact label="Customer">
          {customer ? <a href={`/customers/${customer.id}`} className="hover:underline">{customer.name}</a> : null}
        </Fact>
        <Fact label="Visit">
          <a href={`/visits/${report.visitId}`} className="hover:underline">Open the visit</a>
          {" · "}
          <a href={`/jobs/${report.jobId}`} className="hover:underline">Open the job</a>
        </Fact>
        <Fact label="Submitted">{report.submittedAt ? formatIn(report.submittedAt, zone) : "Not yet: still on the phone"}</Fact>
        <Fact label="Shown to the customer since">{report.publishedAt ? formatIn(report.publishedAt, zone) : null}</Fact>
        <Fact label="Skipped">{report.skipped ? (report.skipReason ?? "No reason given") : null}</Fact>
      </Facts>

      <section aria-label="What was recorded" className="mt-8">
        <h2 className="text-base font-semibold">What was recorded</h2>
        {report.summary ? <p className="mt-2 whitespace-pre-wrap text-sm">{report.summary}</p> : null}
        {outOfRange > 0 ? (
          <p className="mt-2 text-sm text-amber-700">
            {outOfRange === 1 ? "One reading is" : `${outOfRange} readings are`} outside the range the report&apos;s template allows.
          </p>
        ) : null}
        {report.fields.length === 0 ? (
          <Empty title="Nothing recorded">The technician recorded no answers on this report.</Empty>
        ) : (
          <Table label="Answers" head={<><Th>Question</Th><Th>Answer</Th><Th>Customer sees it</Th></>}>
            {report.fields.map((f) => (
              <tr key={`${f.key}-${f.recordedAt}`}>
                <Td>{f.label}</Td>
                <Td>
                  {shown(f.value, f.unit)}
                  {f.outOfRange ? <span className="ml-2"><Chip tone="warning">Out of range</Chip></span> : null}
                  {f.chemical ? (
                    <span className="block text-xs text-ink-500">
                      {[f.chemical.productName, f.chemical.epaRegistrationNumber ? `EPA ${f.chemical.epaRegistrationNumber}` : null,
                        f.chemical.quantityApplied ? `${Number(f.chemical.quantityApplied)} ${f.chemical.applicationUnit ?? ""}`.trim() : null,
                        f.chemical.targetPest ? `for ${f.chemical.targetPest}` : null,
                        f.chemical.applicatorLicense ? `licence ${f.chemical.applicatorLicense}` : null]
                        .filter(Boolean).join(", ")}
                    </span>
                  ) : null}
                </Td>
                <Td>{f.customerVisible ? "Yes" : "No"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section aria-label="Technician's notes" className="mt-8">
        <h2 className="text-base font-semibold">Technician&apos;s notes</h2>
        <p className="mt-1 text-xs text-ink-500">What the technician wrote. Never shown to the customer, and nobody can change it.</p>
        <p className="mt-2 whitespace-pre-wrap text-sm">{report.technicianNotes ?? "None."}</p>
      </section>

      <section aria-label="Office note" className="mt-8">
        <h2 className="text-base font-semibold">Office note</h2>
        <p className="mt-1 text-xs text-ink-500">
          The customer sees the summary and this note on their account once the report is published, under
          &quot;Noted for next time&quot;.
        </p>
        {writes && !published && !report.skipped ? (
          <ActionForm action={actOnServiceReport} submit="Save" hidden={{ id, op: "annotate" }} className="mt-3 space-y-3">
            <TextArea label="Summary" name="summary" rows={2} maxLength={4000} defaultValue={report.summary ?? ""} />
            <TextArea label="Office note" name="observations" rows={3} maxLength={4000} defaultValue={report.observations ?? ""} />
          </ActionForm>
        ) : (
          <>
            <p className="mt-2 whitespace-pre-wrap text-sm">{report.observations ?? "None."}</p>
            {writes && published ? (
              <p className="mt-1 text-xs text-ink-500">The customer has this report. Take it back first to change it.</p>
            ) : null}
          </>
        )}
      </section>

      {publishes && report.status === "submitted" ? (
        <section aria-label="Publish" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">Show it to the customer</h2>
          <p className="mt-1 text-sm text-ink-700">
            The customer sees it on their account and their portal: the summary, the answers marked yes above and the
            office note. Not the technician&apos;s notes and not the answers marked no.
          </p>
          <ActionForm action={actOnServiceReport} submit="Publish to the customer" hidden={{ id, op: "publish" }}
                      className="mt-3" />
        </section>
      ) : null}

      {publishes && published ? (
        <details className="mt-8 rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Take it back from the customer</summary>
          <p className="mt-2 text-sm text-ink-700">
            The customer stops seeing it. Your reason is added to the office note, so if you publish it again they
            will read it there.
          </p>
          <ActionForm action={actOnServiceReport} submit="Take it back" tone="danger" hidden={{ id, op: "unpublish" }}
                      className="mt-3 space-y-3">
            <TextField label="Why it is taken back" name="reason" required maxLength={1000}
                       placeholder="The superheat reading was typed wrong." />
          </ActionForm>
        </details>
      ) : null}

      {report.status === "draft" ? (
        <p className="mt-8 text-sm text-ink-700">
          The technician has not submitted it yet, so it cannot be published: the phone may still change it.
        </p>
      ) : null}

      <HoldPanel ctx={ctx} entityType="service_report" entityId={report.id} path={`/service-reports/${report.id}`}
                 label="this report" timezone={zone} />
    </div>
  );
}
