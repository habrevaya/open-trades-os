import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { statementDelivery } from "@opentradesos/api/services";
import { PortalBrand } from "../../PortalBrand";
import { PrintButton } from "@/components/PrintButton";
import { StatementView, type StatementData } from "@/components/Statement";

export const dynamic = "force-dynamic";

const DAY = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * ONE STATEMENT, AND NOTHING ELSE OF THE ACCOUNT
 *
 * The link in a copy of a statement sent to an address the office typed. It
 * opens the period that statement was for, read from the books now, and its
 * PDF. There is no way from here to the customer's account: no back link, no
 * invoice links, nothing that takes a period or an id from the address bar.
 * Every failure, an expired or stopped link included, is the same 404 as every
 * other page behind a link.
 */
export default async function StatementLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let statement: StatementData & { linkExpiresAt: string };
  try {
    statement = await statementDelivery.viewStatementLink(getDb(), { token });
  } catch {
    notFound();
  }
  return (
    <PortalBrand token={token}>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-ink-500">
          A copy of {statement.customerName}&apos;s statement. This link opens it until{" "}
          {DAY.format(new Date(statement.linkExpiresAt))}.
        </p>
        <span className="flex items-center gap-3">
          <a href={`/s/${token}/pdf`} className="text-sm underline underline-offset-4">Download PDF</a>
          <PrintButton />
        </span>
      </div>
      <div className="rounded-md border border-steel-200 bg-canvas p-5">
        <StatementView statement={statement} timezone="UTC" withContact={false} />
      </div>
    </PortalBrand>
  );
}
