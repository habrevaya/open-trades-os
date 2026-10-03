import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { requirePortalSession } from "@/lib/portal-session";
import { PortalBrand } from "../../../../PortalBrand";
import { PrintButton } from "@/components/PrintButton";
import { StatementView, type StatementData } from "@/components/Statement";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The signed in customer's statement: the same document the account link
 * shows, read by the same service from the ledger, for the customer the
 * sign in names.
 */
export default async function SignedInStatementPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const session = await requirePortalSession(slug);
  const query = await searchParams;
  const from = query.from && DATE.test(query.from) ? query.from : undefined;
  const to = query.to && DATE.test(query.to) ? query.to : undefined;
  const statement: StatementData = await portalAccount.viewStatement(getDb(), { token: session.token, from, to })
    .catch((error: unknown) => {
      // A period the statement cannot show falls back to the default one, as on the link page.
      if (error instanceof Error && error.name === "UnprocessableError") {
        return portalAccount.viewStatement(getDb(), { token: session.token });
      }
      throw error;
    });
  const base = `/portal/${encodeURIComponent(slug)}`;
  return (
    <PortalBrand token={session.token} logoHref={`${base}/logo`}>
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={`${base}/account`} className="text-sm text-ink-500 hover:underline">Back to your account</a>
        <span className="flex items-center gap-3">
          <a href={`${base}/account/statement/pdf?from=${statement.from}&to=${statement.to}`}
             className="text-sm underline underline-offset-4">Download PDF</a>
          <PrintButton />
        </span>
      </div>
      <div className="rounded-md border border-steel-200 bg-canvas p-5">
        <StatementView statement={statement} timezone="UTC" />
      </div>
    </PortalBrand>
  );
}
