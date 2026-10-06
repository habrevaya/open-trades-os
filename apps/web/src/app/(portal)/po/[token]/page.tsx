import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { purchaseOrderEmail } from "@opentradesos/api/services";
import { money } from "@opentradesos/core";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

const dollars = (v: string) => money.format(money.money(v));

/**
 * A PURCHASE ORDER, AS THE VENDOR READS IT
 *
 * The page an emailed order links to. Rendered from the token alone: the
 * link names the company and the order, and nothing else of the company can
 * be reached from it. Their part number first, because that is what a supply
 * house counter reads, and printable, because many still pick from paper.
 */
export default async function VendorOrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let order: Awaited<ReturnType<typeof purchaseOrderEmail.forVendor>>;
  try {
    order = await purchaseOrderEmail.forVendor(getDb(), { token });
  } catch {
    notFound();
  }

  return (
    <div className="space-y-6 rounded-md border border-steel-200 bg-canvas p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-700">{order.organizationName}</p>
          <h1 className="mt-1 text-2xl font-semibold">Purchase order {order.number}</h1>
          <p className="mt-1 text-sm text-ink-500">
            To {order.vendorName}{order.vendorAccount ? `, account ${order.vendorAccount}` : ""}
          </p>
        </div>
        <div className="print:hidden"><PrintButton label="Print" /></div>
      </header>
      <table className="w-full text-sm">
        <thead className="border-b border-steel-200 text-left">
          <tr>
            <th className="py-2 pr-2 font-medium">Part</th>
            <th className="py-2 pr-2 font-medium">Description</th>
            <th className="py-2 pr-2 text-right font-medium">Qty</th>
            <th className="py-2 pr-2 text-right font-medium">Each</th>
            <th className="py-2 text-right font-medium">Line</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-steel-200">
          {order.lines.map((line, i) => (
            <tr key={i}>
              <td className="py-2 pr-2 font-mono">{line.vendorPartNumber ?? line.itemCode}</td>
              <td className="py-2 pr-2">
                {line.itemName}
                <span className="block text-xs text-ink-500">Deliver to {line.deliverTo}</span>
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">
                {line.packs ? `${line.packs.count} ${line.packs.unit ?? "pack"} of ${line.packs.size} (${line.quantityOrdered})` : line.quantityOrdered}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">{dollars(line.packs ? line.packs.price : line.unitPrice)}</td>
              <td className="py-2 text-right tabular-nums">{dollars(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-right text-lg font-semibold">Total {dollars(order.total)}</p>
      {order.notes ? <p className="whitespace-pre-line text-sm text-ink-700">{order.notes}</p> : null}
      <p className="text-sm text-ink-500">Reply to the email this came with to confirm the order and when it will ship.</p>
    </div>
  );
}
