import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { creditNotes } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { label, tone } from "@/lib/labels";
import { formatDay } from "@/lib/dates";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { CREDIT_REASON, CREDIT_STATUS, CREDIT_TONE } from "./labels";

export const dynamic = "force-dynamic";

/**
 * CREDIT NOTES
 *
 * Every credit the company has given, newest first, with what is still
 * unused. The unused column is the one that matters: it is money the company
 * owes customers, and until it is used or refunded it sits on the books.
 */
export default async function CreditNotesPage() {
  const user = await requireSetupUser();
  const page = await creditNotes.list({ actor: user.actor, db: getDb() }, { limit: 100 });
  const unused = page.data
    .filter((n) => n.status === "open" || n.status === "partially_applied")
    .reduce((sum, n) => sum + Number(n.balance), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Credit notes" count={page.data.length} />
      {unused > 0 && (
        <p className="mt-2 text-sm text-ink-700">
          <Money value={unused.toFixed(2)} /> given and not yet used against an invoice.
        </p>
      )}

      {page.data.length === 0 ? (
        <Empty title="No credit notes yet">
          A credit is raised from the invoice that asked for too much, or from a
          customer when it is not about one invoice.
        </Empty>
      ) : (
        <Table label="Credit notes" head={
          <>
            <Th className="w-20">Number</Th><Th>Customer</Th><Th>Why</Th><Th>Status</Th>
            <Th className="text-right">Credit</Th><Th className="text-right">Unused</Th><Th>Issued</Th>
          </>
        }>
          {page.data.map((note) => (
            <tr key={note.id} className="hover:bg-steel-100">
              <Td className="font-mono tabular-nums text-ink-700">
                <a href={`/invoices/credit-notes/${note.id}`} className="hover:underline">{note.number}</a>
              </Td>
              <Td>
                <a href={`/invoices/credit-notes/${note.id}`} className="font-medium text-ink-900 hover:underline">
                  {note.customerName}
                </a>
                {note.invoiceNumber !== null ? (
                  <span className="ml-2 text-xs text-ink-500">on invoice {note.invoiceNumber}</span>
                ) : null}
              </Td>
              <Td className="text-ink-700">{label(CREDIT_REASON, note.reason)}</Td>
              <Td><Chip tone={tone(CREDIT_TONE, note.status)}>{label(CREDIT_STATUS, note.status)}</Chip></Td>
              <Td className="text-right"><Money value={note.total} /></Td>
              <Td className="text-right"><Money value={note.balance} muted={Number(note.balance) === 0} /></Td>
              <Td className="text-ink-700">{note.issuedOn ? formatDay(note.issuedOn, user.organizationTimezone) : ""}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
