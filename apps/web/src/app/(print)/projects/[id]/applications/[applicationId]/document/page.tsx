import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects, projectApplications, NotFoundError } from "@opentradesos/api/services";
import { can, money } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Application for payment" };

const pct = (rate: string) => `${Number((Number(rate) * 100).toFixed(2))}%`;

/**
 * AN APPLICATION FOR PAYMENT ON PAPER.
 *
 * In the two page shape every certifier, owner's representative and lender
 * reads: a summary page with the nine numbered lines and the certification,
 * and a continuation sheet with a column per figure for every line of the
 * schedule of values, lettered so a reader can follow which column feeds
 * which line. It is the common shape of that document and deliberately not
 * any association's published form or its name.
 *
 * A draft prints with DRAFT across the top, because a draft printed and
 * handed over is a draft somebody pays.
 */
export default async function ApplicationDocument({ params }: { params: Promise<{ id: string; applicationId: string }> }) {
  const user = await requireSetupUser();
  if (!can(user.actor, "invoice:read")) notFound();
  const { id, applicationId } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const application = await projectApplications.get(ctx, { id: applicationId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  if (application.projectId !== id) notFound();
  const project = await projects.get(ctx, { id });
  const t = application.totals;
  const sum = (key: "scheduledValue" | "previousWork" | "workThisPeriod" | "storedNow" | "completedAndStored" | "balanceToFinish") =>
    money.toString(money.sum(application.lines.map((l) => money.money(l[key]))));

  return (
    <article className="text-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <a href={`/projects/${id}/applications/${application.id}`} className="text-sm text-ink-500 hover:underline">Back</a>
        <PrintButton label="Print or save as PDF" />
      </div>

      {application.status === "draft" && (
        <p className="mt-4 border border-red-600 p-2 text-center text-sm font-semibold text-red-600">
          DRAFT: not yet invoiced{application.problems.length > 0 ? `. ${application.problems.join(" ")}` : ""}
        </p>
      )}

      <section aria-label="Application summary" className="mt-6 break-after-page print:mt-0">
        <header className="flex flex-wrap justify-between gap-4 border-b border-ink-900 pb-3">
          <div>
            <p className="text-sm text-ink-500">{user.organizationName}</p>
            <h1 className="text-xl font-semibold">Application for payment {application.number}</h1>
            <p className="text-sm">{project.name}</p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt className="text-ink-500">Period</dt>
            <dd>{application.periodFrom ? `${application.periodFrom} to ` : "Up to "}{application.periodTo}</dd>
            <dt className="text-ink-500">Application</dt><dd>{application.number}</dd>
            <dt className="text-ink-500">Status</dt><dd>{application.status === "invoiced" ? "Invoiced" : "Draft"}</dd>
          </dl>
        </header>

        {t ? (
          <table className="mt-4 w-full max-w-xl text-sm">
            <tbody>
              <Line n="1" label="Original contract sum" value={t.originalContractSum} />
              <Line n="2" label="Net change by change orders" value={t.netChangeOrders} />
              <Line n="3" label="Contract sum to date (line 1 plus line 2)" value={t.contractSumToDate} />
              <Line n="4" label="Total completed and stored to date (column G)" value={t.totalCompletedAndStored} />
              <tr><td className="py-1 pr-2 align-top">5</td><td className="py-1" colSpan={2}>Retainage</td></tr>
              <Line n="" label={`a. ${pct(application.retainageRate)} of completed work (columns D plus E)`} value={t.retainageOnWork} indent />
              <Line n="" label={`b. ${pct(application.storedRetainageRate)} of stored material (column F)`} value={t.retainageOnStored} indent />
              <Line n="" label="c. Released to date" value={money.toString(money.negate(money.money(t.retainageReleased)))} indent />
              <Line n="" label="Total retainage" value={t.totalRetainage} />
              <Line n="6" label="Total earned less retainage (line 4 less line 5)" value={t.totalEarnedLessRetainage} />
              <Line n="7" label="Less previous certificates for payment (line 6 of the prior application)" value={t.previousCertificates} />
              <Line n="8" label="Current payment due" value={t.currentPaymentDue} strong />
              <Line n="9" label="Balance to finish, including retainage (line 3 less line 6)" value={t.balanceToFinish} />
            </tbody>
          </table>
        ) : (
          <p className="mt-4 text-sm">The figures do not add up yet, so there is no summary to print.</p>
        )}

        <div className="mt-8 grid gap-8 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">Contractor</p>
            <p className="mt-1 text-ink-700">
              We confirm the work listed here has been done as the contract requires, that money paid on earlier
              applications went to the work it was for, and that the payment on line 8 is now due.
            </p>
            <p className="mt-1 text-ink-700">{user.organizationName}</p>
            <div className="mt-8 border-b border-ink-900" />
            <p className="mt-1 text-ink-500">Signature, name and date</p>
          </div>
          <div>
            <p className="font-medium">Certified for payment</p>
            <p className="mt-1 text-ink-700">Amount certified. Where it differs from line 8, say why.</p>
            <div className="mt-6 border-b border-ink-900" />
            <div className="mt-8 border-b border-ink-900" />
            <p className="mt-1 text-ink-500">Signature, name and date</p>
          </div>
        </div>
        {application.notes && <p className="mt-6 whitespace-pre-line text-sm"><span className="font-medium">Notes: </span>{application.notes}</p>}
      </section>

      <section aria-label="Continuation sheet" className="mt-10">
        <h2 className="text-base font-semibold">Continuation sheet, application {application.number}</h2>
        <table className="mt-2 w-full border-collapse">
          <thead>
            <tr className="border-y border-ink-900 text-left align-bottom">
              <th className="px-1 py-1 font-medium">A<br />Item</th>
              <th className="px-1 py-1 font-medium">B<br />Description of work</th>
              <th className="px-1 py-1 text-right font-medium">C<br />Scheduled value</th>
              <th className="px-1 py-1 text-right font-medium">D<br />From previous application</th>
              <th className="px-1 py-1 text-right font-medium">E<br />This period</th>
              <th className="px-1 py-1 text-right font-medium">F<br />Materials presently stored</th>
              <th className="px-1 py-1 text-right font-medium">G<br />Completed and stored to date</th>
              <th className="px-1 py-1 text-right font-medium">%<br />(G / C)</th>
              <th className="px-1 py-1 text-right font-medium">H<br />Balance to finish</th>
            </tr>
          </thead>
          <tbody>
            {application.lines.map((line, i) => (
              <tr key={line.id} className="border-b border-steel-200">
                <td className="px-1 py-1 tabular-nums">{i + 1}</td>
                <td className="px-1 py-1">{line.description}</td>
                <td className="px-1 py-1 text-right tabular-nums"><Money value={line.scheduledValue} /></td>
                <td className="px-1 py-1 text-right tabular-nums"><Money value={line.previousWork} /></td>
                <td className="px-1 py-1 text-right tabular-nums"><Money value={line.workThisPeriod} /></td>
                <td className="px-1 py-1 text-right tabular-nums"><Money value={line.storedNow} /></td>
                <td className="px-1 py-1 text-right tabular-nums"><Money value={line.completedAndStored} /></td>
                <td className="px-1 py-1 text-right tabular-nums">{line.percentComplete}</td>
                <td className="px-1 py-1 text-right tabular-nums"><Money value={line.balanceToFinish} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-y border-ink-900 font-medium">
              <td className="px-1 py-1" colSpan={2}>Totals</td>
              <td className="px-1 py-1 text-right tabular-nums"><Money value={sum("scheduledValue")} /></td>
              <td className="px-1 py-1 text-right tabular-nums"><Money value={sum("previousWork")} /></td>
              <td className="px-1 py-1 text-right tabular-nums"><Money value={sum("workThisPeriod")} /></td>
              <td className="px-1 py-1 text-right tabular-nums"><Money value={sum("storedNow")} /></td>
              <td className="px-1 py-1 text-right tabular-nums"><Money value={sum("completedAndStored")} /></td>
              <td className="px-1 py-1" />
              <td className="px-1 py-1 text-right tabular-nums"><Money value={sum("balanceToFinish")} /></td>
            </tr>
          </tfoot>
        </table>
      </section>
    </article>
  );
}

function Line({ n, label, value, indent = false, strong = false }: {
  n: string; label: string; value: string; indent?: boolean; strong?: boolean;
}) {
  return (
    <tr className={strong ? "border-y border-ink-900 font-semibold" : undefined}>
      <td className="py-1 pr-2 align-top">{n}</td>
      <td className={`py-1 ${indent ? "pl-4" : ""}`}>{label}</td>
      <td className="py-1 text-right tabular-nums"><Money value={value} /></td>
    </tr>
  );
}
