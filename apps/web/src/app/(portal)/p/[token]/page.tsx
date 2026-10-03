import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { payerDelivery } from "@opentradesos/api/services";
import { PortalBrand } from "../../PortalBrand";

export const dynamic = "force-dynamic";

type Portal = Awaited<ReturnType<typeof payerDelivery.viewPortal>>;

const money = (value: string) =>
  Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });

const day = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const STATUS: Record<string, string> = { open: "Open", partially_paid: "Part paid", paid: "Paid" };

/**
 * EVERYTHING ONE PAYER OWES US, ON ONE PAGE
 *
 * For the clerk at a home warranty company or a facilities client's
 * accounts payable who would rather keep one link than forty emails. Open
 * invoices first, then what they paid this year, each with its lines and
 * whose price each line is, because the question a payer asks of a
 * commercial invoice is whether it matches their schedule.
 *
 * The same 404 for an expired, revoked or never issued link, for the reason
 * every portal page gives. The download is the same open invoices as a CSV,
 * for loading into their own system.
 */
export default async function PayerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let portal: Portal;
  try {
    portal = await payerDelivery.viewPortal(getDb(), { token });
  } catch {
    notFound();
  }
  const open = portal.invoices.filter((i) => i.status === "open" || i.status === "partially_paid");

  return (
    <PortalBrand token={token}>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{portal.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Invoices for {portal.payerName}</h1>
        <p className="mt-1 text-sm text-ink-700">
          {open.length === 0 ? "Nothing is owed." : `${open.length} open, ${money(portal.owed)} owed.`}
        </p>
        {open.length > 0 && (
          <a href={`/p/${token}/invoices.csv`} className="mt-2 inline-block text-sm text-ink-700 underline">
            Download the open invoices as a spreadsheet
          </a>
        )}
      </header>

      <ul className="mt-6 space-y-4">
        {portal.invoices.map((invoice) => (
          <li key={invoice.number} className="rounded-lg border border-steel-200 bg-canvas p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">Invoice #{invoice.number}</h2>
              <span className="text-sm text-ink-700">{STATUS[invoice.status] ?? invoice.status}</span>
            </div>
            <p className="mt-1 text-xs text-ink-500">
              {[
                invoice.issuedOn && `Issued ${day(invoice.issuedOn)}`,
                invoice.dueOn && `due ${day(invoice.dueOn)}`,
                invoice.jobNumber !== null && `job ${invoice.jobNumber}`,
                invoice.purchaseOrderNumber && `PO ${invoice.purchaseOrderNumber}`,
                invoice.claimReference && `your claim ${invoice.claimReference}`,
              ].filter(Boolean).join(", ")}
            </p>
            {invoice.siteAddress && <p className="text-xs text-ink-500">{invoice.siteAddress}, for {invoice.customerName}</p>}
            <table className="mt-3 w-full text-sm">
              <tbody>
                {invoice.lines.map((line, i) => (
                  <tr key={i} className="border-t border-steel-200 align-top">
                    <td className="py-1.5 pr-2">
                      {line.name}
                      {line.description && <span className="block text-xs text-ink-500">{line.description}</span>}
                      <span className="block text-xs text-ink-500">Priced by {line.priceAuthority}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{money(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-right text-sm">
              Total {money(invoice.total)}
              {Number(invoice.amountPaid) > 0 && <>, paid {money(invoice.amountPaid)}</>}
              {Number(invoice.balance) > 0 && <span className="font-semibold">, {money(invoice.balance)} owed</span>}
            </p>
          </li>
        ))}
      </ul>
    </PortalBrand>
  );
}
