import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { statements, NotFoundError } from "@opentradesos/api/services";
import { Crumb } from "@/components/Detail";
import { PrintButton } from "@/components/PrintButton";
import { StatementView } from "@/components/Statement";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A customer's statement, for a period the office picks. GET, so a period is
 * a link somebody can send to a colleague and the browser's back button works.
 */
export default async function StatementPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const query = await searchParams;
  const from = query.from && DATE.test(query.from) ? query.from : undefined;
  const to = query.to && DATE.test(query.to) ? query.to : undefined;

  let refusal: string | null = null;
  const ctx = { actor: user.actor, db: getDb() };
  const statement = await statements.statement(ctx, { id, ...(from ? { from } : {}), ...(to ? { to } : {}) })
    .catch(async (error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      if (error instanceof Error && error.name === "UnprocessableError") {
        refusal = error.message;
        return statements.statement(ctx, { id });
      }
      throw error;
    });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Crumb href={`/customers/${id}`}>{statement.customerName}</Crumb>
        <PrintButton label="Print statement" />
      </div>
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 print:hidden">
        <label className="block text-sm">
          <span className="font-medium text-ink-700">From</span>
          <input type="date" name="from" defaultValue={statement.from}
                 className="mt-1 h-10 rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-ink-700">To</span>
          <input type="date" name="to" defaultValue={statement.to}
                 className="mt-1 h-10 rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <button type="submit" className="h-10 rounded bg-ink-900 px-3 text-sm font-medium text-white">Show</button>
      </form>
      {refusal && <p role="alert" className="mt-3 text-sm text-red-600">{refusal}. Showing the last ninety days instead.</p>}
      <div className="mt-8">
        <StatementView statement={statement} timezone={user.organizationTimezone} invoiceHref={(invoiceId) => `/invoices/${invoiceId}`} />
      </div>
    </div>
  );
}
