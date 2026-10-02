import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { PortalBrand } from "../../../PortalBrand";
import { PrintButton } from "@/components/PrintButton";
import { StatementView, type StatementData } from "@/components/Statement";

export const dynamic = "force-dynamic";

/**
 * The customer's statement, from their account link: the last ninety days,
 * the running balance, and what is still open. Every failure is the same 404,
 * like every other page behind a link.
 */
export default async function PortalStatementPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let statement: StatementData;
  try {
    statement = await portalAccount.viewStatement(getDb(), { token });
  } catch {
    notFound();
  }
  return (
    <PortalBrand token={token}>
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={`/c/${token}`} className="text-sm text-ink-500 hover:underline">Back to your account</a>
        <PrintButton />
      </div>
      <div className="rounded-md border border-steel-200 bg-canvas p-5">
        <StatementView statement={statement} timezone="UTC" />
      </div>
    </PortalBrand>
  );
}
