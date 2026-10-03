import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { projectChangeOrders } from "@opentradesos/api/services";
import { money } from "@opentradesos/core";
import { PortalBrand } from "../../PortalBrand";
import { ApproveChange } from "./ApproveChange";

export const dynamic = "force-dynamic";

const dollars = (v: string) => money.format(money.money(v));

/**
 * A CHANGE ORDER, AS THE CUSTOMER SEES IT.
 *
 * Rendered from the token alone, like the estimate page: no project id, no
 * change order id and no company id in the address, because the grant
 * resolves all three. It says what the work is, every line and its price,
 * and in one sentence what agreeing does to their contract, because that
 * sentence is the thing they are actually signing.
 */
export default async function ChangeOrderPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let order: Awaited<ReturnType<typeof projectChangeOrders.viewForCustomer>>;
  try {
    order = await projectChangeOrders.viewForCustomer(getDb(), { token });
  } catch {
    notFound();
  }

  const credit = order.amount.startsWith("-");
  const effect = order.contractValue && order.contractValueAfter
    ? `${credit ? `This takes ${dollars(order.amount.slice(1))} off` : `This adds ${dollars(order.amount)} to`} your contract of `
      + `${dollars(order.contractValue)}, making it ${dollars(order.contractValueAfter)}.`
    : `${credit ? "This takes" : "This adds"} ${dollars(order.amount.replace(/^-/, ""))} ${credit ? "off" : "to"} your contract.`;
  const days = order.scheduleDays && order.scheduleDays !== 0
    ? order.scheduleDays > 0 ? ` It adds ${order.scheduleDays} days to the job.` : ` It takes ${-order.scheduleDays} days off the job.`
    : "";

  return (
    <PortalBrand token={token}>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{order.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Change order {order.number}: {order.title}</h1>
        <p className="mt-1 text-sm text-ink-500">{order.projectName}, {order.propertyAddress}</p>
      </header>

      <section className="rounded-md border border-steel-200 bg-canvas p-5">
        {order.description && <p className="whitespace-pre-line text-sm text-ink-700">{order.description}</p>}
        {order.reason && <p className="mt-2 text-sm text-ink-500">Why: {order.reason}</p>}
        <ul className="mt-4 space-y-2 text-sm">
          {order.lines.map((line, i) => (
            <li key={i} className="flex justify-between gap-4">
              <span className="text-ink-700">
                {Number(line.quantity) !== 1 && `${Number(line.quantity)} × `}{line.name}
                {line.description && <span className="block text-xs text-ink-500">{line.description}</span>}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-ink-500">{dollars(line.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-baseline justify-between border-t border-steel-200 pt-4">
          <span className="font-medium">{credit ? "Credit" : "Total"}</span>
          <span className="font-mono text-2xl font-semibold tabular-nums">{dollars(order.amount)}</span>
        </div>
      </section>

      {order.status === "sent" ? (
        <ApproveChange token={token} effect={`${effect}${days}`} />
      ) : (
        <div className="rounded-md border border-steel-200 bg-canvas p-6 text-center">
          {order.status === "approved" && (
            <>
              <p className="text-lg font-semibold">Approved</p>
              <p className="mt-1 text-sm text-ink-700">
                Signed by {order.signerName}. Your contract is now {order.contractValueAfter ? dollars(order.contractValueAfter) : "updated"}.
              </p>
            </>
          )}
          {order.status === "declined" && <p className="text-lg font-semibold">You declined this change. Nothing changed on your contract.</p>}
          {order.status !== "approved" && order.status !== "declined" && (
            <p className="text-sm text-ink-700">This change order is not waiting for your answer any more.</p>
          )}
        </div>
      )}
    </PortalBrand>
  );
}
