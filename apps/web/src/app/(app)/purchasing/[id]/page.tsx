import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, NotFoundError } from "@opentradesos/api/services";
import { can, money as m } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { PrintButton } from "@/components/PrintButton";
import { Table, Td, Th } from "@/components/Table";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { decideAction, emailAction, receiveAction } from "./actions";

export const dynamic = "force-dynamic";

const STEP_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  approved: "success", rejected: "danger", waiting: "warning", later: "neutral",
};
const STEP_SAYS: Record<string, string> = {
  approved: "Approved", rejected: "Rejected", waiting: "Waiting", later: "After the step before",
};

/**
 * ONE PURCHASE ORDER, as the vendor reads it: their part number first, then
 * ours, how many and at what, and where each line is going. Printable,
 * because a lot of supply house counters still take an order on paper.
 *
 * Their number is the one copied onto the line when the order was written,
 * so renumbering a part later does not change what this order said.
 *
 * Around it, what happens to an order: who still has to approve it, emailing
 * it to the vendor with a printable link and every attempt recorded, and
 * receiving each delivery with the freight that came on the truck, which is
 * spread into what the parts cost.
 */
export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const order = await inventory.purchaseOrder({ actor: user.actor, db: getDb() }, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const open = ["submitted", "acknowledged", "partially_received"].includes(order.status);
  const writes = can(user.actor, "po:write");
  const approves = can(user.actor, "po:approve");
  const waiting = order.approval.steps.find((s) => s.state === "waiting");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Crumb href="/purchasing">Purchasing</Crumb>
        <PrintButton label="Print order" />
      </div>
      <h1 className="mt-1 text-xl font-semibold">
        Purchase order <span className="font-mono tabular-nums">#{order.number}</span> to {order.vendorName}
      </h1>
      <Facts>
        <Fact label="Status">{order.status.replace(/_/g, " ")}</Fact>
        <Fact label="Our account">{order.vendorAccount}</Fact>
        <Fact label="Sent">{order.submittedAt ? formatIn(order.submittedAt, user.organizationTimezone) : null}</Fact>
        <Fact label="Expected">{order.expectedAt ? formatIn(order.expectedAt, user.organizationTimezone) : null}</Fact>
      </Facts>
      <Table label="Lines" head={
        <>
          <Th>Their part number</Th><Th>Our item</Th><Th>Deliver to</Th>
          <Th className="text-right">Ordered</Th><Th className="text-right">Arrived</Th>
          <Th className="text-right">Each</Th><Th className="text-right">Line</Th>
        </>
      }>
        {order.lines.map((line) => (
          <tr key={line.id}>
            <Td className="font-mono">{line.vendorPartNumber ?? <span className="text-ink-500">none recorded</span>}</Td>
            <Td>
              <span className="font-mono text-ink-500">{line.itemCode}</span> {line.itemName}
              {line.units.length > 0 ? (
                <div className="mt-1 text-xs text-ink-500 print:hidden">
                  {line.units.map((u) => <a key={u.id} href={`/inventory/serials/${u.id}`} className="mr-2 font-mono hover:underline">{u.number}</a>)}
                </div>
              ) : null}
              {m.isZero(m.money(line.landedCost)) ? null : (
                <div className="text-xs text-ink-500 print:hidden">Freight spread onto it: <Money value={line.landedCost} /></div>
              )}
            </Td>
            <Td className="text-ink-700">{line.locationName}</Td>
            <Td className="text-right tabular-nums">{Number(line.quantityOrdered)}</Td>
            <Td className="text-right tabular-nums">{Number(line.quantityReceived)}</Td>
            <Td className="text-right"><Money value={line.unitPrice} /></Td>
            <Td className="text-right"><Money value={m.toString(m.round(m.multiply(m.money(line.unitPrice), line.quantityOrdered), 2))} /></Td>
          </tr>
        ))}
      </Table>
      <p className="mt-3 text-right text-sm font-medium">Total <Money value={order.total} /></p>
      {order.notes ? <p className="mt-4 whitespace-pre-line text-sm text-ink-700">{order.notes}</p> : null}

      <section className="mt-8 print:hidden" aria-labelledby="approval">
        <h2 id="approval" className="text-base font-semibold">Approval</h2>
        <p className="mt-1 text-sm text-ink-700">{order.approval.sentence}</p>
        {order.approval.steps.length > 0 ? (
          <ol className="mt-2 space-y-1 text-sm">
            {order.approval.steps.map((step) => (
              <li key={step.step} className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-ink-500">Step {step.step}</span>
                <span>{step.roleLabel}, at or over <Money value={step.minimumTotal} /></span>
                <Chip tone={STEP_TONE[step.state] ?? "neutral"}>{STEP_SAYS[step.state] ?? step.state}</Chip>
                {step.decidedBy ? <span className="text-ink-500">by {step.decidedBy}{step.note ? `: ${step.note}` : ""}</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {order.status === "draft" && waiting && approves ? (
          <ActionForm action={decideAction} submit="Decide" className="mt-3 flex flex-wrap items-end gap-3" hidden={{ id: order.id }}>
            <Select label="Your decision" name="decision" className="w-40" options={[
              { value: "approved", label: "Approve" }, { value: "rejected", label: "Reject" },
            ]} />
            <TextField label="Note (needed to reject)" name="note" className="w-72" />
          </ActionForm>
        ) : null}
      </section>

      {writes && order.status !== "received" && order.status !== "cancelled" ? (
        <section className="mt-8 print:hidden" aria-labelledby="email">
          <h2 id="email" className="text-base font-semibold">{order.status === "draft" ? "Send to the vendor" : "Email a copy"}</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            By email, with every line in it and a link that opens this order printable as they read it.
            {order.status === "draft" ? " Sending a draft sends the order: it has to be approved first." : ""}
          </p>
          <ActionForm action={emailAction} submit={order.status === "draft" ? "Email to vendor" : "Email a copy"}
                      className="mt-3 space-y-3" hidden={{ id: order.id }}>
            <TextField label="To (empty for the vendor's address on file)" name="to" type="email" />
            <TextArea label="Message" name="message" rows={2} />
          </ActionForm>
        </section>
      ) : null}

      {order.sends.length > 0 ? (
        <section className="mt-6 print:hidden">
          <h3 className="text-sm font-medium">Sent</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {order.sends.map((send) => (
              <li key={send.id}>
                {formatIn(send.sentAt, user.organizationTimezone)}: to {send.destination ?? "nobody"}{" "}
                <Chip tone={send.state === "queued" ? "info" : "danger"}>{send.state === "queued" ? "Queued" : "Not sent"}</Chip>
                {send.sentBy ? <span className="ml-2 text-ink-500">by {send.sentBy}</span> : null}
                {send.explanation ? <span className="ml-2 text-red-600">{send.explanation}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {writes && open ? (
        <section className="mt-8 print:hidden" aria-labelledby="receive">
          <h2 id="receive" className="text-base font-semibold">Receive a delivery</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            What came on this truck. A part tracked by serial or lot needs its numbers. Freight and fees on the
            vendor&apos;s bill are spread over the lines that arrived, by what each cost or by how many, so the parts are
            used on jobs at what they really cost.
          </p>
          <ActionForm action={receiveAction} submit="Receive" className="mt-3 space-y-4" hidden={{ id: order.id }}>
            <div className="space-y-3">
              {order.lines.filter((l) => Number(l.quantityReceived) < Number(l.quantityOrdered)).map((line) => (
                <div key={line.id} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="lineId" value={line.id} />
                  <TextField label={`${line.itemName}, arrived`} name={`quantity:${line.id}`} inputMode="decimal" className="w-56"
                             defaultValue={line.tracking === "serial" ? "" : String(Number(line.quantityOrdered) - Number(line.quantityReceived))} />
                  {line.tracking ? (
                    <div className="w-72"><TextArea label={`${line.itemName}, ${line.tracking === "serial" ? "serial numbers" : "lot"}`} name={`units:${line.id}`} rows={2} /></div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Charge on the bill" name="chargeDescription" placeholder="Freight" />
              <TextField label="Amount" name="chargeAmount" inputMode="decimal" />
              <Select label="Spread it by" name="basis" options={[
                { value: "value", label: "What each line cost" }, { value: "quantity", label: "How many of each" },
              ]} />
              <TextField label="Another charge" name="chargeDescription" placeholder="Fuel surcharge" />
              <TextField label="Amount" name="chargeAmount" inputMode="decimal" />
            </div>
          </ActionForm>
        </section>
      ) : null}

      {order.receipts.length > 0 ? (
        <section className="mt-8 print:hidden">
          <h2 className="text-base font-semibold">Deliveries</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {order.receipts.map((r) => (
              <li key={r.id}>
                {formatIn(r.receivedAt, user.organizationTimezone)}
                {r.charges.length > 0 ? (
                  <span className="text-ink-700">
                    {": "}{r.charges.map((c) => `${c.description} ${m.format(m.money(c.amount))}`).join(", ")}, spread by {r.basis === "value" ? "value" : "quantity"}
                  </span>
                ) : <span className="text-ink-500">: no freight or fees</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
