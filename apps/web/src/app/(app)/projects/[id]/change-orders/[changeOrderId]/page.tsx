import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceBook, projectChangeOrders, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { TextField } from "@/components/ActionForm";
import { ChangeOrderForm } from "../../../ChangeOrderForms";
import { CHANGE_ORDER_STATUS, CHANGE_ORDER_TONE } from "../../../ChangeOrderLabels";

export const dynamic = "force-dynamic";

const PRICE_SOURCE: Record<string, string> = {
  price_book: "Price book", rate_card: "Customer's rate card", manual: "Typed",
};

/**
 * ONE CHANGE ORDER: price it, send it, and record what the customer said.
 *
 * Lines can change only before it is sent, because the customer's signature
 * covers the page as sent. Recording a yes given in person is here for the
 * person who may approve on the customer's behalf; the customer's own yes
 * comes through their link.
 */
export default async function ChangeOrderPage({ params }: { params: Promise<{ id: string; changeOrderId: string }> }) {
  const user = await requireSetupUser();
  const { id, changeOrderId } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const order = await projectChangeOrders.get(ctx, { id: changeOrderId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  if (order.projectId !== id) notFound();

  const editable = order.status === "requested" || order.status === "priced";
  const prices = can(user.actor, "estimate:write");
  const items = editable && prices && can(user.actor, "pricebook:read")
    ? (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
    : [];
  const hidden = { projectId: id, changeOrderId };
  const field = "mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/projects/${id}/change-orders`}>Change orders</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Change order {order.number}: {order.title}</h1>
        <Chip tone={CHANGE_ORDER_TONE[order.status] ?? "neutral"}>{CHANGE_ORDER_STATUS[order.status] ?? order.status}</Chip>
        <Link href={`/projects/${id}/change-orders/${order.id}/document`} className="text-sm underline underline-offset-4">
          Printable change order
        </Link>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-ink-500">Amount</dt><dd className="text-lg font-semibold tabular-nums"><Money value={order.amount} /></dd></div>
        {order.cost !== null && <div><dt className="text-ink-500">Our cost</dt><dd className="tabular-nums"><Money value={order.cost} /></dd></div>}
        <div><dt className="text-ink-500">Lands on</dt><dd>{order.phaseName ?? "Its own line on the schedule of values"}</dd></div>
        {order.scheduleDays !== null && <div><dt className="text-ink-500">Time</dt><dd>{order.scheduleDays >= 0 ? `Adds ${order.scheduleDays} days` : `Saves ${-order.scheduleDays} days`}</dd></div>}
        {order.requestedBy && <div><dt className="text-ink-500">Asked for by</dt><dd>{order.requestedBy}</dd></div>}
        {order.reason && <div><dt className="text-ink-500">Why</dt><dd>{order.reason}</dd></div>}
      </dl>
      {order.description && <p className="mt-3 max-w-prose whitespace-pre-line text-sm text-ink-700">{order.description}</p>}

      {order.status === "approved" && (
        <p className="mt-4 rounded-md border border-steel-200 bg-green-tint p-3 text-sm text-ink-900">
          Agreed by {order.signerName} {order.decidedVia === "portal" ? "through their link" : "and recorded by the office"}.
          The contract went from <Money value={order.contractValueBefore ?? "0"} /> to <Money value={order.contractValueAfter ?? "0"} />.
        </p>
      )}
      {order.status === "declined" && (
        <p className="mt-4 rounded-md border border-steel-200 bg-red-tint p-3 text-sm text-ink-900">
          Declined{order.declineReason ? `: ${order.declineReason}` : "."} Nothing changed on the contract.
        </p>
      )}
      {order.status === "void" && (
        <p className="mt-4 rounded-md border border-steel-200 bg-steel-100 p-3 text-sm text-ink-900">Withdrawn: {order.voidReason}</p>
      )}

      <h2 className="mt-8 text-base font-semibold">Lines</h2>
      {order.lines.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">Nothing priced yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-md border border-steel-200">
          <table className="w-full text-sm">
            <thead className="bg-steel-100 text-left text-ink-700">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Priced from</th>
                {editable && prices && <th className="px-3 py-2"><span className="sr-only">Remove</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-200 bg-canvas">
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-3 py-2">{line.name}{line.description && <span className="block text-xs text-ink-500">{line.description}</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{Number(line.quantity)}</td>
                  <td className="px-3 py-2 text-right tabular-nums"><Money value={line.unitPrice} /></td>
                  <td className="px-3 py-2 text-right tabular-nums"><Money value={line.lineTotal} /></td>
                  <td className="px-3 py-2 text-ink-700">{PRICE_SOURCE[line.priceSource] ?? line.priceSource}</td>
                  {editable && prices && (
                    <td className="px-3 py-2">
                      <ChangeOrderForm submit="Remove" tone="quiet" className="" hidden={{ ...hidden, op: "remove-line", lineId: line.id }} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editable && prices && (
        <section className="mt-6 grid gap-6 md:grid-cols-2" aria-label="Price a line">
          <div className="rounded-md border border-steel-200 bg-canvas p-4">
            <h3 className="text-sm font-semibold">From the price book</h3>
            <p className="mt-1 text-xs text-ink-500">Takes the customer&apos;s rate card price where their contract has one. A negative quantity takes work out.</p>
            <ChangeOrderForm submit="Add line" hidden={{ ...hidden, op: "line" }}>
              <label className="block">
                <span className="text-sm font-medium text-ink-700">Item</span>
                <select name="priceBookItemId" required defaultValue="" className={field}>
                  <option value="" disabled>Choose an item</option>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.code}: {item.name}</option>)}
                </select>
              </label>
              <TextField label="Quantity" name="quantity" inputMode="decimal" defaultValue="1" />
            </ChangeOrderForm>
          </div>
          <div className="rounded-md border border-steel-200 bg-canvas p-4">
            <h3 className="text-sm font-semibold">Typed by hand</h3>
            <p className="mt-1 text-xs text-ink-500">For work the price book does not have, at the price agreed.</p>
            <ChangeOrderForm submit="Add line" hidden={{ ...hidden, op: "line" }}>
              <TextField label="What it is" name="name" required />
              <div className="grid grid-cols-3 gap-2">
                <TextField label="Quantity" name="quantity" inputMode="decimal" defaultValue="1" />
                <TextField label="Price" name="unitPrice" inputMode="decimal" required />
                {can(user.actor, "job.cost:read") && <TextField label="Our cost" name="unitCost" inputMode="decimal" />}
              </div>
            </ChangeOrderForm>
          </div>
        </section>
      )}

      {(order.status === "priced" || order.status === "sent") && can(user.actor, "estimate:send") && can(user.actor, "portal:grant") && (
        <section className="mt-8 max-w-2xl" aria-label="Send to the customer">
          <h2 className="text-base font-semibold">{order.status === "sent" ? "Send it again" : "Send it to the customer to sign"}</h2>
          <p className="mt-1 text-sm text-ink-500">
            The customer gets a page with the lines and what it does to their contract, and approves and signs it or
            declines it there. {order.status === "sent" ? "A new link stops the earlier one working." : ""}
          </p>
          <ChangeOrderForm submit="Send" hidden={{ ...hidden, op: "send" }}>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="channel" value="email" defaultChecked /> Email it to them</label>
              <label className="flex items-center gap-2"><input type="radio" name="channel" value="link" /> Just give me the link</label>
            </fieldset>
          </ChangeOrderForm>
        </section>
      )}

      {(order.status === "priced" || order.status === "sent") && can(user.actor, "estimate:approve") && (
        <section className="mt-8 max-w-2xl" aria-label="Record their answer">
          <h2 className="text-base font-semibold">Record their answer</h2>
          <p className="mt-1 text-sm text-ink-500">
            When the customer signed a paper copy or agreed in writing. Agreeing changes the contract value now.
          </p>
          <ChangeOrderForm submit="Record" hidden={{ ...hidden, op: "decide" }}>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="decision" value="approved" defaultChecked /> They agreed</label>
              <label className="flex items-center gap-2"><input type="radio" name="decision" value="declined" /> They declined</label>
            </fieldset>
            <TextField label="Who signed or answered" name="signerName" />
            <TextField label="Reason, if they declined" name="reason" />
          </ChangeOrderForm>
        </section>
      )}

      {(order.status === "requested" || order.status === "priced" || order.status === "sent") && prices && (
        <section className="mt-8 max-w-2xl" aria-label="Withdraw">
          <h2 className="text-base font-semibold">Withdraw it</h2>
          <ChangeOrderForm submit="Withdraw" tone="danger" hidden={{ ...hidden, op: "withdraw" }}>
            <TextField label="Why" name="reason" required />
          </ChangeOrderForm>
        </section>
      )}
    </div>
  );
}
