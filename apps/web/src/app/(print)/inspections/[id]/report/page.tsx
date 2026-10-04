import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { PrintButton } from "@/components/PrintButton";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Inspection report" };

const RESULT: Record<string, string> = {
  pass: "Passed", pass_with_deficiencies: "Passed, with findings", fail: "Failed",
  partial: "Not finished: some checkpoints were not answered", not_tested: "Not tested", not_accessible: "Could not get to it",
};
const VERDICT: Record<string, string> = {
  pass: "Pass", borderline: "In range, near the limit", finding: "Finding",
  not_applicable: "Not applicable", not_answered: "Not answered",
};

/**
 * THE INSPECTION REPORT ON PAPER.
 *
 * Rendered from the data held: every checkpoint as it was asked, what was
 * recorded and what it came to, the range each reading was judged against,
 * the findings with their severity, code and the date they must be put
 * right by, photographs, the inspector and their licence, the signature and
 * when it is next due. A programme whose report goes to an authority names
 * the authority and the standard at the top, because that is who the page
 * is for. Nothing on it is typed afresh: a report is a record of what was
 * filed, not a document somebody writes.
 */
export default async function InspectionReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  if (!can(user.actor, "compliance:read")) notFound();
  const { id } = await params;
  const report = await inspections.report({ actor: user.actor, db: getDb() }, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const forAuthority = report.program.reportAudience !== "customer";

  return (
    <article className="text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <a href="/inspections" className="text-ink-500 hover:underline">Back</a>
        <PrintButton label="Print or save as PDF" />
      </div>

      <header className="mt-6 border-b border-ink-900 pb-4 print:mt-0">
        <p className="text-ink-500">{report.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{report.program.name}</h1>
        {forAuthority && report.program.authorityName && (
          <p className="mt-1">Report for {report.program.authorityName}</p>
        )}
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div><dt className="inline text-ink-500">Property: </dt><dd className="inline">{report.property.address}</dd></div>
          <div><dt className="inline text-ink-500">Customer: </dt><dd className="inline">{report.customer.name}</dd></div>
          <div><dt className="inline text-ink-500">Inspected on: </dt><dd className="inline">{report.performedOn ?? "Not recorded"}</dd></div>
          <div><dt className="inline text-ink-500">Next due: </dt><dd className="inline">{report.nextDueOn ?? "Not set"}</dd></div>
          {report.program.standard && <div><dt className="inline text-ink-500">Performed under: </dt><dd className="inline">{report.program.standard}</dd></div>}
          <div><dt className="inline text-ink-500">Programme version: </dt><dd className="inline">{report.program.version ?? "Not recorded"}</dd></div>
          <div><dt className="inline text-ink-500">Inspector: </dt><dd className="inline">{report.inspectorName ?? "Not recorded"}</dd></div>
          <div><dt className="inline text-ink-500">Licence: </dt><dd className="inline">{report.inspectorLicense ?? "Not recorded"}</dd></div>
        </dl>
      </header>

      <section aria-label="Result" className="mt-4">
        <p className="text-lg font-semibold">{RESULT[report.result ?? ""] ?? report.result ?? "No result"}</p>
        {report.statement && <p className="mt-1 text-ink-700">{report.statement}</p>}
        {!report.checkpointsKept && (
          <p className="mt-2 border border-amber-700 p-2 text-ink-900">
            This inspection was filed before its checkpoints were kept with it, so the questions below are the
            programme&apos;s as it is now and may not be exactly what was asked.
          </p>
        )}
      </section>

      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr className="border-y border-ink-900 text-left">
            <th className="py-1 pr-2 font-medium">Checkpoint</th>
            <th className="py-1 pr-2 font-medium">Recorded</th>
            <th className="py-1 pr-2 font-medium">Acceptable</th>
            <th className="py-1 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {report.items.map((item) => (
            <tr key={item.key} className="border-b border-steel-200 align-top">
              <td className="py-1.5 pr-2">
                {item.prompt}
                {item.note && <span className="block text-ink-500">{item.note}</span>}
                {item.photos.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {item.photos.map((photo) => photo.storageKey
                      ? <img key={photo.id} src={`/files/${photo.storageKey}`} alt={`Photo for ${item.prompt}`} className="h-20 w-20 rounded object-cover" />
                      : <span key={photo.id} className="text-xs text-ink-500">A photo still on its way from the phone</span>)}
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2">{item.answer ?? ""}</td>
              <td className="py-1.5 pr-2 text-ink-700">{item.range ?? (item.kind === "pass_fail" ? "Pass" : "")}</td>
              <td className={`py-1.5 ${item.verdict === "finding" ? "font-semibold text-red-600" : ""}`}>
                {VERDICT[item.verdict] ?? item.verdict}{item.severity && item.verdict !== "pass" ? `: ${item.severity}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section aria-label="Findings" className="mt-6">
        <h2 className="text-base font-semibold">Findings</h2>
        {report.deficiencies.length === 0 ? (
          <p className="mt-1 text-ink-700">Nothing was found that needs putting right.</p>
        ) : (
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr className="border-y border-ink-900 text-left">
                <th className="py-1 pr-2 font-medium">Severity</th>
                <th className="py-1 pr-2 font-medium">Finding</th>
                <th className="py-1 pr-2 font-medium">Code</th>
                <th className="py-1 pr-2 font-medium">Correct by</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.deficiencies.map((d) => (
                <tr key={d.id} className="border-b border-steel-200 align-top">
                  <td className="py-1.5 pr-2 font-medium">{d.label}</td>
                  <td className="py-1.5 pr-2">{d.description}</td>
                  <td className="py-1.5 pr-2">{d.code ?? ""}</td>
                  <td className="py-1.5 pr-2">{d.correctByOn ?? "No deadline"}</td>
                  <td className="py-1.5">{d.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Signature" className="mt-8 grid gap-8 sm:grid-cols-2">
        <div>
          <p className="text-ink-500">Inspector</p>
          {report.signature ? (
            <>
              {report.signature.storageKey && (
                <img src={`/files/${report.signature.storageKey}`} alt={`Signature of ${report.signature.name}`} className="mt-2 h-16" />
              )}
              <p className="mt-2 text-base">{report.signature.name}</p>
              {report.signature.at && (
                <p className="text-ink-500">Signed {formatIn(report.signature.at, user.organizationTimezone, { dateStyle: "medium", timeStyle: "short" })}</p>
              )}
            </>
          ) : (
            <>
              <div className="mt-10 border-b border-ink-900" />
              <p className="mt-1 text-ink-500">Signature, name and date</p>
            </>
          )}
        </div>
        {report.submissionReference && (
          <div>
            <p className="text-ink-500">Filed with the authority</p>
            <p className="mt-2">Reference {report.submissionReference}</p>
          </div>
        )}
      </section>
    </article>
  );
}
