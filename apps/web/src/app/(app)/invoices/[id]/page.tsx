import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, NotFoundError } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";

export const dynamic = "force-dynamic";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;

  const invoice = await billing.get({ actor: user.actor, db: getDb() }, { id })
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/invoices">Invoices</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          Invoice <span className="font-mono tabular-nums">{invoice.number}</span>
        </h1>
        <Chip tone={invoice.status === "paid" ? "success" : "info"}>{invoice.status}</Chip>
      </div>

      <Facts>
        <Fact label="Issued">{invoice.issuedOn}</Fact>
        <Fact label="Due">{invoice.dueOn}</Fact>
        <Fact label="Total"><Money value={invoice.total} /></Fact>
        <Fact label="Balance"><Money value={invoice.balance} /></Fact>
      </Facts>

      <Table head={
        <>
          <Th>Line</Th>
          <Th className="text-right">Qty</Th>
          <Th className="text-right">Unit</Th>
          <Th className="text-right">Amount</Th>
        </>
      }>
        {invoice.lines.map((line) => (
          <tr key={line.id}>
            <Td>
              <span className="font-medium">{line.name}</span>
              {line.description ? <p className="mt-0.5 text-ink-700">{line.description}</p> : null}
            </Td>
            <Td className="text-right font-mono tabular-nums">{line.quantity}</Td>
            <Td className="text-right"><Money value={line.unitPrice} /></Td>
            <Td className="text-right"><Money value={line.lineTotal} /></Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
