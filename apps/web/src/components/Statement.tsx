import { Money } from "@opentradesos/ui";
import { formatDay } from "@/lib/dates";

export interface StatementData {
  customerName: string;
  organizationName: string;
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  owedOnInvoices: string;
  heldOnAccount: string;
  lines: {
    date: string; description: string; invoiceId: string | null;
    charge: string | null; credit: string | null; balance: string;
  }[];
  aging: { current: string; days1To30: string; days31To60: string; days61To90: string; over90: string };
  openInvoices: { id: string; number: number; issuedOn: string | null; dueOn: string | null; total: string; balance: string; daysOverdue: number }[];
}

/**
 * A STATEMENT, AS A DOCUMENT
 *
 * Shared by the office and the customer's own link, so the two can never show
 * different numbers for the same period. Laid out to print: the period and the
 * two balances first, because that is what the reader came for, then every line
 * with a running balance, then what is still open and how late it is.
 *
 * A negative balance is money the company owes the customer, and says so in
 * words rather than as a minus sign somebody misreads.
 */
export function StatementView({ statement, timezone, invoiceHref }: {
  statement: StatementData;
  timezone: string;
  /** Where an invoice line links to, or nowhere. */
  invoiceHref?: (id: string) => string;
}) {
  const closing = Number(statement.closingBalance);
  const owes = (value: string) => Number(value) < 0
    ? <><Money value={String(-Number(value))} /> <span className="text-xs text-ink-500">in credit</span></>
    : <Money value={value} />;
  const buckets: [string, string][] = [
    ["Not yet due", statement.aging.current], ["1 to 30 days late", statement.aging.days1To30],
    ["31 to 60", statement.aging.days31To60], ["61 to 90", statement.aging.days61To90],
    ["Over 90", statement.aging.over90],
  ];

  return (
    <article aria-label="Statement" className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-steel-200 pb-4">
        <div>
          <p className="text-sm text-ink-500">{statement.organizationName}</p>
          <h1 className="text-xl font-semibold">Statement for {statement.customerName}</h1>
          <p className="mt-1 text-sm text-ink-700">
            {formatDay(statement.from, timezone)} to {formatDay(statement.to, timezone)}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <dt className="text-ink-500">Owed at the start</dt><dd className="text-right">{owes(statement.openingBalance)}</dd>
          <dt className="font-medium">{closing < 0 ? "In credit at the end" : "Owed at the end"}</dt>
          <dd className="text-right font-medium">{owes(statement.closingBalance)}</dd>
        </dl>
      </header>

      <section aria-label="Activity">
        <h2 className="text-base font-semibold">Activity</h2>
        {statement.lines.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Nothing charged, paid or credited in this period.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-steel-200 text-left text-xs uppercase tracking-[0.08em] text-ink-500">
                <th className="py-2 font-medium">Date</th>
                <th className="py-2 font-medium">What</th>
                <th className="py-2 text-right font-medium">Charged</th>
                <th className="py-2 text-right font-medium">Paid or credited</th>
                <th className="py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-200">
              {statement.lines.map((line, i) => (
                <tr key={i}>
                  <td className="py-2 text-ink-700">{formatDay(line.date, timezone)}</td>
                  <td className="py-2">
                    {line.invoiceId && invoiceHref
                      ? <a href={invoiceHref(line.invoiceId)} className="hover:underline">{line.description}</a>
                      : line.description}
                  </td>
                  <td className="py-2 text-right">{line.charge ? <Money value={line.charge} /> : null}</td>
                  <td className="py-2 text-right">{line.credit ? <Money value={line.credit} /> : null}</td>
                  <td className="py-2 text-right">{owes(line.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Still open">
        <h2 className="text-base font-semibold">Still open</h2>
        {statement.openInvoices.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No invoice is waiting to be paid.</p>
        ) : (
          <>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-steel-200 text-left text-xs uppercase tracking-[0.08em] text-ink-500">
                  <th className="py-2 font-medium">Invoice</th>
                  <th className="py-2 font-medium">Due</th>
                  <th className="py-2 text-right font-medium">Total</th>
                  <th className="py-2 text-right font-medium">Still owed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-200">
                {statement.openInvoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="py-2 font-mono tabular-nums">
                      {invoiceHref
                        ? <a href={invoiceHref(invoice.id)} className="hover:underline">{invoice.number}</a>
                        : invoice.number}
                    </td>
                    <td className={`py-2 ${invoice.daysOverdue > 0 ? "text-red-600" : "text-ink-700"}`}>
                      {invoice.dueOn ? formatDay(invoice.dueOn, timezone) : ""}
                      {invoice.daysOverdue > 0 ? `, ${invoice.daysOverdue === 1 ? "1 day" : `${invoice.daysOverdue} days`} late` : ""}
                    </td>
                    <td className="py-2 text-right"><Money value={invoice.total} /></td>
                    <td className="py-2 text-right"><Money value={invoice.balance} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl aria-label="How late" className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              {buckets.map(([label, value]) => (
                <div key={label} className="rounded border border-steel-200 p-2">
                  <dt className="text-xs text-ink-500">{label}</dt>
                  <dd className="mt-0.5"><Money value={value} muted={Number(value) === 0} /></dd>
                </div>
              ))}
            </dl>
          </>
        )}
        {Number(statement.heldOnAccount) > 0 && (
          <p className="mt-3 text-sm text-ink-700">
            <Money value={statement.heldOnAccount} /> is held on the account, paid ahead or credited, and
            comes off the next invoice.
          </p>
        )}
      </section>
    </article>
  );
}
