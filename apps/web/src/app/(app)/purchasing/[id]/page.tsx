import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, NotFoundError } from "@opentradesos/api/services";
import { money as m } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { PrintButton } from "@/components/PrintButton";
import { Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * ONE PURCHASE ORDER, as the vendor reads it: their part number first, then
 * ours, how many and at what, and where each line is going. Printable,
 * because a lot of supply house counters still take an order on paper.
 *
 * Their number is the one copied onto the line when the order was written,
 * so renumbering a part later does not change what this order said.
 */
export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const order = await inventory.purchaseOrder({ actor: user.actor, db: getDb() }, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

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
      <Table head={
        <>
          <Th>Their part number</Th><Th>Our item</Th><Th>Deliver to</Th>
          <Th className="text-right">Ordered</Th><Th className="text-right">Arrived</Th>
          <Th className="text-right">Each</Th><Th className="text-right">Line</Th>
        </>
      }>
        {order.lines.map((line) => (
          <tr key={line.id}>
            <Td className="font-mono">{line.vendorPartNumber ?? <span className="text-ink-500">none recorded</span>}</Td>
            <Td><span className="font-mono text-ink-500">{line.itemCode}</span> {line.itemName}</Td>
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
    </div>
  );
}
