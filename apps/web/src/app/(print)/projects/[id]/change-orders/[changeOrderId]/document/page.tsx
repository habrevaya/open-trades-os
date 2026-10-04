import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projectChangeOrders, NotFoundError } from "@opentradesos/api/services";
import { Money } from "@opentradesos/ui";
import { PrintButton } from "@/components/PrintButton";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Change order" };

/**
 * A CHANGE ORDER ON PAPER.
 *
 * What the customer signs, or signed: the work, every line with its price,
 * the total, what it does to the contract, the days it adds, and the
 * signature block. Once agreed it prints who signed it and when, and the
 * first characters of the hash the signature was recorded against, so the
 * paper can be matched to the record.
 */
export default async function ChangeOrderDocument({ params }: { params: Promise<{ id: string; changeOrderId: string }> }) {
  const user = await requireSetupUser();
  const { id, changeOrderId } = await params;
  const order = await projectChangeOrders.documentFor({ actor: user.actor, db: getDb() }, { id: changeOrderId })
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    });
  if (order.projectId !== id) notFound();
  const credit = order.amount.startsWith("-");
  const before = order.status === "approved" ? order.contractValueBefore : order.contractValueNow;
  const after = order.status === "approved" ? order.contractValueAfter : order.contractValueIfAgreed;

  return (
    <article className="text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <a href={`/projects/${id}/change-orders/${order.id}`} className="text-ink-500 hover:underline">Back</a>
        <PrintButton label="Print or save as PDF" />
      </div>

      <header className="mt-6 flex flex-wrap justify-between gap-4 border-b border-steel-200 pb-4 print:mt-0">
        <div>
          <p className="text-ink-500">{order.organizationName}</p>
          <h1 className="mt-1 text-2xl font-semibold">Change order {order.number}</h1>
          <p className="mt-1 text-base">{order.title}</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-ink-500">Project</dt><dd>{order.projectName}</dd>
          <dt className="text-ink-500">Customer</dt><dd>{order.customerName}</dd>
          <dt className="text-ink-500">Address</dt><dd>{order.propertyAddress}</dd>
          <dt className="text-ink-500">Raised</dt><dd>{formatIn(order.createdAt, user.organizationTimezone, { dateStyle: "medium" })}</dd>
        </dl>
      </header>

      {order.description && <p className="mt-4 whitespace-pre-line">{order.description}</p>}
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1">
        {order.reason && <div><dt className="inline text-ink-500">Reason: </dt><dd className="inline">{order.reason}</dd></div>}
        {order.requestedBy && <div><dt className="inline text-ink-500">Asked for by: </dt><dd className="inline">{order.requestedBy}</dd></div>}
        <div><dt className="inline text-ink-500">Part of the work: </dt><dd className="inline">{order.phaseName ?? "A new line on the schedule of values"}</dd></div>
        <div><dt className="inline text-ink-500">Time: </dt><dd className="inline">
          {order.scheduleDays === null || order.scheduleDays === 0 ? "No change to the schedule"
            : order.scheduleDays > 0 ? `Adds ${order.scheduleDays} days` : `Saves ${-order.scheduleDays} days`}
        </dd></div>
      </dl>

      <table className="mt-6 w-full border-collapse">
        <thead>
          <tr className="border-b border-ink-900 text-left">
            <th className="py-2 font-medium">Item</th>
            <th className="py-2 text-right font-medium">Quantity</th>
            <th className="py-2 text-right font-medium">Price</th>
            <th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id} className="border-b border-steel-200 align-top">
              <td className="py-2">{line.name}{line.description && <span className="block text-ink-500">{line.description}</span>}</td>
              <td className="py-2 text-right tabular-nums">{Number(line.quantity)}</td>
              <td className="py-2 text-right tabular-nums"><Money value={line.unitPrice} /></td>
              <td className="py-2 text-right tabular-nums"><Money value={line.lineTotal} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="py-2 text-right font-medium">{credit ? "Credit to the contract" : "Added to the contract"}</td>
            <td className="py-2 text-right text-base font-semibold tabular-nums"><Money value={order.amount} /></td>
          </tr>
        </tfoot>
      </table>

      {before !== null && after !== null && (
        <dl className="mt-4 ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-y-1">
          <dt className="text-ink-500">Contract before this change</dt><dd className="text-right tabular-nums"><Money value={before} /></dd>
          <dt className="text-ink-500">This change</dt><dd className="text-right tabular-nums"><Money value={order.amount} /></dd>
          <dt className="font-medium">Contract with this change</dt><dd className="text-right font-medium tabular-nums"><Money value={after} /></dd>
        </dl>
      )}

      <section className="mt-10 grid gap-8 sm:grid-cols-2" aria-label="Signatures">
        {order.status === "approved" ? (
          <div>
            <p className="text-ink-500">Agreed by the customer</p>
            <p className="mt-2 text-lg">{order.signerName}</p>
            <p className="text-ink-500">
              {order.decidedVia === "portal" ? "Signed through the customer's link" : "Recorded by the office"}
              {order.signedAt ? `, ${formatIn(order.signedAt, user.organizationTimezone, { dateStyle: "medium", timeStyle: "short" })}` : ""}
            </p>
            {order.documentHash && <p className="mt-1 font-mono text-xs text-ink-500">Document {order.documentHash.slice(0, 16)}</p>}
          </div>
        ) : (
          <div>
            <p className="text-ink-500">Customer</p>
            <div className="mt-10 border-b border-ink-900" />
            <p className="mt-1 text-ink-500">Signature, name and date</p>
          </div>
        )}
        <div>
          <p className="text-ink-500">{order.organizationName}</p>
          <div className="mt-10 border-b border-ink-900" />
          <p className="mt-1 text-ink-500">Signature, name and date</p>
        </div>
      </section>
      {order.status === "declined" && <p className="mt-6 font-medium">Declined{order.declineReason ? `: ${order.declineReason}` : ""}.</p>}
      {order.status === "void" && <p className="mt-6 font-medium">Withdrawn: {order.voidReason}</p>}
    </article>
  );
}
