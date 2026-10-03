import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalAccount, referrals } from "@opentradesos/api/services";
import { PortalBrand } from "../../PortalBrand";
import { PayInvoice } from "../../PayInvoice";
import { AccountView, type AccountViewData } from "./AccountView";
import { startAccountPayment } from "./actions";
import { ReferralBlock } from "./ReferralBlock";

export const dynamic = "force-dynamic";

/**
 * The customer's whole account, from a customer-scope link.
 *
 * That link could be minted through the API and opened a 404. It resolves
 * from the token alone like the invoice page: peeked to read, so every
 * refresh costs nothing, and every failure is the same 404.
 */
export default async function AccountPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const returned = typeof query["redirect_status"] === "string" ? query["redirect_status"] : null;

  let account: AccountViewData;
  try {
    account = await portalAccount.viewAccount(getDb(), { token });
  } catch {
    notFound();
  }
  /** Never the reason the page fails: an account opens whether or not this does. */
  const referral = await referrals.forPortal(getDb(), { token }).catch(() => null);

  return (
    <PortalBrand token={token}>
      <AccountView
        account={account}
        returned={returned}
        statementHref={`/c/${token}/statement`}
        pdfHref={(invoiceId) => `/c/${token}/invoices/${invoiceId}/pdf`}
        changeHref={(visitId) => `/c/${token}/change/${visitId}`}
        pay={(invoice) => (
          <PayInvoice
            start={startAccountPayment.bind(null, token, invoice.id)}
            balance={invoice.balance}
            currency={invoice.currency}
            tipping={invoice.tipping}
            label={`invoice #${invoice.number}`}
          />
        )}
      />
      {referral ? <ReferralBlock referral={referral} /> : null}
    </PortalBrand>
  );
}
