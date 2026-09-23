import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { INVOICE_STATUS, INVOICE_TONE, label, tone } from "@/lib/labels";
import { todayIn, formatDay } from "@/lib/dates";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * OVERDUE IS A FACT ABOUT TODAY, NOT A STORED STATE
 *
 * There is no `overdue` status on purpose: an invoice that has to be marked
 * overdue by a nightly job is an invoice that is quietly not overdue whenever
 * that job fails. It is derived here, from the due date and the company's
 * today, which cannot fail silently.
 *
 * Compared as date strings, which works because both sides are ISO and it
 * avoids parsing a date-only value into a timestamp at UTC midnight and then
 * asking a question about a different day.
 */
function daysOverdue(dueOn: string | null, today: string): number {
  if (!dueOn || dueOn >= today) return 0;
  const ms = new Date(`${today}T00:00:00Z`).getTime() - new Date(`${dueOn}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * RECEIVABLES
 *
 * Ordered newest first, which is not the same as most useful. The aging view
 * an owner actually opens needs a running total per bucket and is a report
 * rather than a list, so it is not here yet and this does not pretend
 * otherwise. What is here is the part that does not need a report: which of
 * these is late, and by how long.
 */
export default async function InvoicesPage() {
  const user = await requireSetupUser();

  const page = await billing.list({ actor: user.actor, db: getDb() }, { limit: 100 });
  // The company's today. A shop in Austin looking at a server in UTC at nine
  // in the evening would otherwise be told an invoice is a day later than it
  // is, which at a due date boundary is the difference between late and not.
  const today = todayIn(user.organizationTimezone);
  const late = page.data.filter((i) => daysOverdue(i.dueOn, today) > 0 && i.balance !== "0").length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Invoices" count={page.data.length} />

      {late > 0 && (
        <p className="mt-2 text-sm text-ink-700">
          {late === 1 ? "One invoice is" : `${late} invoices are`} past due.
        </p>
      )}

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
          {page.data.map((invoice) => {
            const over = invoice.balance === "0" ? 0 : daysOverdue(invoice.dueOn, today);
            return (
            <tr key={invoice.id} className="hover:bg-steel-100">
              <Td className="font-mono tabular-nums text-ink-700">{invoice.number}</Td>
              <Td>
                <a href={`/invoices/${invoice.id}`} className="font-medium text-ink-900 hover:underline">
                  {invoice.customerName}
                </a>
              </Td>
              <Td>
                {/*
                  Overdue replaces the status rather than sitting beside it.
                  "Open" next to "34 days late" is two chips saying one thing,
                  and the one that matters loses.
                */}
                {over > 0
                  ? <Chip tone="danger">{over === 1 ? "1 day late" : `${over} days late`}</Chip>
                  : (
                    <Chip tone={tone(INVOICE_TONE, invoice.status)}>
                      {label(INVOICE_STATUS, invoice.status)}
                    </Chip>
                  )}
              </Td>
              <Td className="text-right"><Money value={invoice.total} /></Td>
              <Td className="text-right"><Money value={invoice.balance} muted={invoice.balance === "0"} /></Td>
              <Td className={over > 0 ? "text-red-600" : "text-ink-700"}>
                {invoice.dueOn ? formatDay(invoice.dueOn, user.organizationTimezone) : ""}
              </Td>
            </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}
