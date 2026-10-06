import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projectApplications, NotFoundError } from "@opentradesos/api/services";
import { can, money } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { TextArea } from "@/components/ActionForm";
import { ApplicationForm } from "../../../ChangeOrderForms";

export const dynamic = "force-dynamic";

/** The continuation sheet: a form while it is a draft, and the same table, read only, once invoiced. */
function Sheet({ writes, hidden, children }: { writes: boolean; hidden: Record<string, string>; children: React.ReactNode }) {
  return writes
    ? <ApplicationForm submit="Save" hidden={hidden} className="mt-4 space-y-4">{children}</ApplicationForm>
    : <div className="mt-4 space-y-4">{children}</div>;
}

const cell = "h-8 w-28 rounded border border-steel-300 bg-canvas px-2 text-right text-sm tabular-nums";
const edit = (value: string) => money.edit(money.money(value));
const percent = (rate: string) => String(Number(rate) * 100);

/**
 * ONE APPLICATION FOR PAYMENT.
 *
 * A draft is a continuation sheet to fill in: per line, the work done this
 * period in dollars or how complete the line is to date, and what is stored
 * on site. The summary underneath is worked through on every save, and what
 * is wrong with it (a line past its value, a schedule that does not add up
 * to the contract) is said above it in words. Raising it makes the invoice
 * and freezes every figure.
 */
export default async function ApplicationPage({ params }: { params: Promise<{ id: string; applicationId: string }> }) {
  const user = await requireSetupUser();
  const { id, applicationId } = await params;
  if (!can(user.actor, "invoice:read")) notFound();
  const ctx = { actor: user.actor, db: getDb() };
  const application = await projectApplications.get(ctx, { id: applicationId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  if (application.projectId !== id) notFound();
  const draft = application.status === "draft";
  const writes = can(user.actor, "invoice:write") && draft;
  const hidden = { projectId: id, applicationId };
  const t = application.totals;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <Crumb href={`/projects/${id}/applications`}>Applications for payment</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{application.projectName}: application {application.number}</h1>
        <Chip tone={draft ? "info" : "success"}>{draft ? "Draft" : "Invoiced"}</Chip>
        <Link href={`/projects/${id}/applications/${application.id}/document`} className="text-sm underline underline-offset-4">
          Printable application
        </Link>
        {application.invoiceId && (
          <Link href={`/invoices/${application.invoiceId}`} className="text-sm underline underline-offset-4">Its invoice</Link>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-500">
        {application.periodFrom ? `${application.periodFrom} to ` : "Up to "}{application.periodTo}
      </p>

      {application.problems.length > 0 && (
        <ul role="alert" className="mt-4 list-disc space-y-1 rounded-md border border-red-600 bg-red-tint p-3 pl-8 text-sm text-ink-900">
          {application.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}

      <Sheet writes={writes} hidden={{ ...hidden, op: "save" }}>
        <fieldset disabled={!writes} className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="block">Period starts
              <input type="date" name="periodFrom" defaultValue={application.periodFrom ?? ""} className="ml-2 h-8 rounded border border-steel-300 px-2" />
            </label>
            <label className="block">Period ends
              <input type="date" name="periodTo" defaultValue={application.periodTo} className="ml-2 h-8 rounded border border-steel-300 px-2" />
            </label>
            <label className="block">Retainage on work
              <input name="retainagePercent" inputMode="decimal" defaultValue={percent(application.retainageRate)} className="ml-2 h-8 w-16 rounded border border-steel-300 px-2 text-right" /> %
            </label>
            <label className="block">On stored materials
              <input name="storedRetainagePercent" inputMode="decimal" defaultValue={percent(application.storedRetainageRate)} className="ml-2 h-8 w-16 rounded border border-steel-300 px-2 text-right" /> %
            </label>
            <label className="block">Retainage released now
              <input name="retainageReleased" inputMode="decimal" defaultValue={edit(application.retainageReleased)} className="ml-2 h-8 w-28 rounded border border-steel-300 px-2 text-right" />
            </label>
          </div>

          <div className="overflow-x-auto rounded-md border border-steel-200">
            <table className="w-full text-sm">
              <thead className="bg-steel-100 text-left text-ink-700">
                <tr>
                  <th className="px-2 py-2 font-medium">Item</th>
                  <th className="px-2 py-2 text-right font-medium">Scheduled value</th>
                  <th className="px-2 py-2 text-right font-medium">From previous</th>
                  <th className="px-2 py-2 text-right font-medium">This period</th>
                  <th className="px-2 py-2 text-right font-medium">Stored now</th>
                  <th className="px-2 py-2 text-right font-medium">Completed and stored</th>
                  <th className="px-2 py-2 text-right font-medium">%</th>
                  <th className="px-2 py-2 text-right font-medium">Balance to finish</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-200 bg-canvas">
                {application.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="px-2 py-2">{line.description}<input type="hidden" name="lineId" value={line.id} /></td>
                    <td className="px-2 py-2 text-right tabular-nums"><Money value={line.scheduledValue} /></td>
                    <td className="px-2 py-2 text-right tabular-nums"><Money value={line.previousWork} /></td>
                    <td className="px-2 py-2 text-right">
                      <input name={`work.${line.id}`} aria-label={`${line.description}, work this period`} inputMode="decimal"
                             defaultValue={edit(line.workThisPeriod)} className={cell} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <input name={`stored.${line.id}`} aria-label={`${line.description}, stored now`} inputMode="decimal"
                             defaultValue={edit(line.storedNow)} className={cell} />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums"><Money value={line.completedAndStored} /></td>
                    <td className="px-2 py-2 text-right">
                      <input name={`percent.${line.id}`} aria-label={`${line.description}, complete to date per cent`} inputMode="decimal"
                             placeholder={line.percentComplete} className="h-8 w-16 rounded border border-steel-300 bg-canvas px-2 text-right text-sm" />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums"><Money value={line.balanceToFinish} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-500">
            Type how complete a line is to date in the % box and the work this period is worked out from it. Otherwise
            type the dollars. Materials stored are what is on site and not yet installed.
          </p>
          <TextArea label="Notes for the certifier" name="notes" defaultValue={application.notes ?? ""} />
        </fieldset>
      </Sheet>

      {t && (
        <section aria-label="Summary" className="mt-8 max-w-xl rounded-md border border-steel-200 bg-canvas p-4">
          <h2 className="text-base font-semibold">Summary</h2>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt>Original contract sum</dt><dd className="text-right tabular-nums"><Money value={t.originalContractSum} /></dd>
            <dt>Net change by change orders</dt><dd className="text-right tabular-nums"><Money value={t.netChangeOrders} /></dd>
            <dt>Contract sum to date</dt><dd className="text-right tabular-nums"><Money value={t.contractSumToDate} /></dd>
            <dt>Completed and stored to date</dt><dd className="text-right tabular-nums"><Money value={t.totalCompletedAndStored} /></dd>
            <dt>Retainage held</dt><dd className="text-right tabular-nums"><Money value={t.totalRetainage} /></dd>
            <dt>Earned less retainage</dt><dd className="text-right tabular-nums"><Money value={t.totalEarnedLessRetainage} /></dd>
            <dt>Less previous certificates</dt><dd className="text-right tabular-nums"><Money value={t.previousCertificates} /></dd>
            <dt className="font-semibold">Payment due now</dt><dd className="text-right font-semibold tabular-nums"><Money value={t.currentPaymentDue} /></dd>
            <dt className="text-ink-500">Balance to finish, with retainage</dt><dd className="text-right tabular-nums text-ink-500"><Money value={t.balanceToFinish} /></dd>
          </dl>
        </section>
      )}

      {writes && (
        <div className="mt-6 flex flex-wrap gap-6">
          <ApplicationForm submit="Raise the invoice" hidden={{ ...hidden, op: "raise" }} className="">
            <p className="text-sm text-ink-500">Makes one invoice for the payment due and freezes this application.</p>
          </ApplicationForm>
          <ApplicationForm submit="Delete this draft" tone="danger" hidden={{ ...hidden, op: "delete" }} className="" />
        </div>
      )}
    </div>
  );
}
