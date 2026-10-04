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
import { decideAction, editAction, emailAction, lateBillAction, receiveAction } from "./actions";

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
 * Around it, what happens to an order: changing it while it is a draft,
 * who still has to approve it and who was told, emailing it to the vendor
 * with the PDF and a printable link and every attempt recorded, receiving
 * each delivery with the freight that came on the truck, and a freight or
 * duty bill that came after a delivery, spread onto it and followed to
 * wherever its parts went.
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
        <div className="flex items-center gap-3">
          <a href={`/purchasing/${order.id}/pdf`} className="text-sm underline underline-offset-4">Download PDF</a>
          <PrintButton label="Print order" />
        </div>
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
            <Td className="text-right tabular-nums">
              {line.packs ? (
                <>
                  {line.packs.count} {line.packs.unit ?? "pack"} of {line.packs.size}
                  <div className="text-xs text-ink-500">{Number(line.quantityOrdered)} in all</div>
                </>
              ) : Number(line.quantityOrdered)}
            </Td>
            <Td className="text-right tabular-nums">{Number(line.quantityReceived)}</Td>
            <Td className="text-right">
              <Money value={line.packs ? line.packs.price : line.unitPrice} />
              {line.packs ? <div className="text-xs text-ink-500">a {line.packs.unit ?? "pack"}</div> : null}
            </Td>
            <Td className="text-right"><Money value={line.lineTotal} /></Td>
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
                <span>
                  {step.roleLabel}, at or over <Money value={step.minimumTotal} />
                  {step.scopeLabel ? <span className="text-ink-500"> on {step.scopeLabel}</span> : null}
                </span>
                <Chip tone={STEP_TONE[step.state] ?? "neutral"}>{STEP_SAYS[step.state] ?? step.state}</Chip>
                {step.decidedBy ? <span className="text-ink-500">by {step.decidedBy}{step.note ? `: ${step.note}` : ""}</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {order.approvalNotices.length > 0 ? (
          <div className="mt-3">
            <h3 className="text-sm font-medium">Told by email</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {order.approvalNotices.map((notice, i) => (
                <li key={i}>
                  {formatIn(notice.at, user.organizationTimezone)}: {notice.name}, for step {notice.step}{" "}
                  <Chip tone={notice.state === "queued" ? "info" : "danger"}>{notice.state === "queued" ? "Emailed" : "Not emailed"}</Chip>
                  {notice.explanation ? <span className="ml-2 text-red-600">{notice.explanation}</span> : null}
                </li>
              ))}
            </ul>
          </div>
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

      {writes && order.status === "draft" && order.approval.state !== "rejected" ? (
        <section className="mt-8 print:hidden" aria-labelledby="edit">
          <h2 id="edit" className="text-base font-semibold">Change the order</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            Before it goes to the vendor. Quantities are in your units, so a part sold by the box of 25 is ordered as
            25, 50 and so on. Set a line to 0 to take it off. Going above what was approved sends it back to be approved again.
          </p>
          <ActionForm action={editAction} submit="Save changes" className="mt-3 space-y-3" hidden={{ id: order.id }}>
            {order.lines.map((line) => (
              <div key={line.id} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="lineId" value={line.id} />
                <input type="hidden" name={`item:${line.id}`} value={line.itemId} />
                <input type="hidden" name={`location:${line.id}`} value={line.locationId} />
                <TextField label={`${line.itemName}, how many`} name={`quantity:${line.id}`} inputMode="decimal" className="w-56"
                           defaultValue={String(Number(line.quantityOrdered))} />
                <TextField label={`${line.itemName}, price each`} name={`price:${line.id}`} inputMode="decimal" className="w-48"
                           defaultValue={String(Number(line.unitPrice))} />
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-3">
              <TextField label="Add a part, by number" name="addPart" className="w-56" />
              <TextField label="How many" name="addQuantity" inputMode="decimal" className="w-32" />
              <TextField label="Price each (empty for theirs)" name="addPrice" inputMode="decimal" className="w-56" />
            </div>
          </ActionForm>
        </section>
      ) : null}

      {writes && order.status !== "received" && order.status !== "cancelled" ? (
        <section className="mt-8 print:hidden" aria-labelledby="email">
          <h2 id="email" className="text-base font-semibold">{order.status === "draft" ? "Send to the vendor" : "Email a copy"}</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            By email, with every line in it, the order as a PDF, and a link that opens this order printable as they read it.
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
        <section className="mt-8 print:hidden" aria-labelledby="deliveries">
          <h2 id="deliveries" className="text-base font-semibold">Deliveries</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {order.receipts.map((r) => (
              <li key={r.id}>
                {formatIn(r.receivedAt, user.organizationTimezone)}
                {r.charges.length > 0 ? (
                  <span className="text-ink-700">
                    {": "}{r.charges.map((c) => `${c.description} ${m.format(m.money(c.amount))}`).join(", ")}, spread by {r.basis === "value" ? "value" : "quantity"}
                  </span>
                ) : <span className="text-ink-500">: no freight or fees</span>}
                {r.lateBills.map((bill) => (
                  <div key={bill.id} className="ml-4 mt-1 text-ink-700">
                    Billed later{bill.reference ? ` (${bill.reference})` : ""}:{" "}
                    {bill.charges.map((c) => `${c.description} ${m.format(m.money(c.amount))}`).join(", ")}.{" "}
                    <Money value={bill.onShelf} /> onto parts still on a shelf, <Money value={bill.onJobs} /> onto jobs that used them,{" "}
                    <Money value={bill.onGone} /> onto stock already gone.
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {writes && order.receipts.length > 0 ? (
        <section className="mt-8 print:hidden" aria-labelledby="late-bill">
          <h2 id="late-bill" className="text-base font-semibold">A freight or duty bill that came later</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            Spread over that delivery the same way as freight on the day, then onto wherever each part is now: the shelf or
            truck it sits on, the job that used it, or the stock already written off or sent back. Parts used on a job put
            their share on that job&apos;s cost.
          </p>
          <ActionForm action={lateBillAction} submit="Spread the bill" className="mt-3 grid gap-3 sm:grid-cols-3" hidden={{ id: order.id }}>
            <Select label="Delivery" name="receiptId" options={order.receipts.map((r) => ({
              value: r.id, label: `Received ${formatIn(r.receivedAt, user.organizationTimezone)}`,
            }))} />
            <TextField label="Their bill number" name="reference" />
            <Select label="Spread it by" name="basis" options={[
              { value: "", label: "As the delivery was" }, { value: "value", label: "What each line cost" }, { value: "quantity", label: "How many of each" },
            ]} />
            <TextField label="Charge" name="lateDescription" placeholder="Freight" />
            <TextField label="Amount" name="lateAmount" inputMode="decimal" />
            <div />
            <TextField label="Another charge" name="lateDescription" placeholder="Duty" />
            <TextField label="Amount" name="lateAmount" inputMode="decimal" />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
