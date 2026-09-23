import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral", open: "info", partial: "warning", paid: "success",
  void: "neutral", uncollectible: "danger",
};

/**
 * RECEIVABLES
 *
 * Ordered newest first, which is not the same as most useful, and the aging
 * view is what an owner actually opens. That needs the due date and a running
 * total per bucket, and it is a report rather than a list, so it is not here
 * yet and this does not pretend otherwise.
 */
export default async function InvoicesPage() {
  const user = await requireSetupUser();

  const page = await billing.list({ actor: user.actor, db: getDb() }, { limit: 100 });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Invoices" count={page.data.length} />

      {page.data.length === 0 ? (
        <Empty title="No invoices yet">
          An invoice comes from a completed job, so the first one arrives once
          work does.
        </Empty>
      ) : (
        <Table head={
          <>
            <Th className="w-20">Number</Th><Th>Customer</Th><Th>Status</Th>
            <Th className="text-right">Total</Th><Th className="text-right">Balance</Th><Th>Due</Th>
          </>
        }>
          {page.data.map((invoice) => (
            <tr key={invoice.id} className="hover:bg-steel-100">
              <Td className="font-mono tabular-nums text-ink-700">{invoice.number}</Td>
              <Td>
                <a href={`/invoices/${invoice.id}`} className="font-medium text-ink-900 hover:underline">
                  {invoice.customerName}
                </a>
              </Td>
              <Td><Chip tone={TONE[invoice.status] ?? "neutral"}>{invoice.status}</Chip></Td>
              <Td className="text-right"><Money value={invoice.total} /></Td>
              <Td className="text-right"><Money value={invoice.balance} muted={invoice.balance === "0"} /></Td>
              <Td className="text-ink-700">{invoice.dueOn ?? ""}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
