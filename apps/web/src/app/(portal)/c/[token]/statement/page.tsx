import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { PortalBrand } from "../../../PortalBrand";
import { PrintButton } from "@/components/PrintButton";
import { StatementView, type StatementData } from "@/components/Statement";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The customer's statement, from their account link: the last ninety days,
 * or the period an emailed statement named, the running balance, and what is
 * still open. Every failure is the same 404, like every other page behind a
 * link.
 */
export default async function PortalStatementPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { token } = await params;
  /**
   * The period an emailed statement was for, carried on its link, so the
   * customer opens the month the email named rather than the last ninety
   * days. A date that is not one is ignored rather than refused: the page is
   * still theirs to read.
   */
  const query = await searchParams;
  const from = query.from && DATE.test(query.from) ? query.from : undefined;
  const to = query.to && DATE.test(query.to) ? query.to : undefined;
  let statement: StatementData;
  try {
    statement = await portalAccount.viewStatement(getDb(), { token, from, to }).catch((error: unknown) => {
      // A period the statement cannot show (ending after today) falls back to the default one.
      if (error instanceof Error && error.name === "UnprocessableError") {
        return portalAccount.viewStatement(getDb(), { token });
      }
      throw error;
    });
  } catch {
    notFound();
  }
  return (
    <PortalBrand token={token}>
      <div className="flex items-center justify-between gap-3 print:hidden">
        <a href={`/c/${token}`} className="text-sm text-ink-500 hover:underline">Back to your account</a>
        <span className="flex items-center gap-3">
          <a href={`/c/${token}/statement/pdf?from=${statement.from}&to=${statement.to}`}
             className="text-sm underline underline-offset-4">Download PDF</a>
          <PrintButton />
        </span>
      </div>
      <div className="rounded-md border border-steel-200 bg-canvas p-5">
        <StatementView statement={statement} timezone="UTC" withContact={false} />
      </div>
    </PortalBrand>
  );
}
