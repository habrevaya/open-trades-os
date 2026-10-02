import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { PortalBrand } from "../../PortalBrand";
import { PayNow } from "../../PayNow";
import { AccountView, money, type AccountViewData } from "./AccountView";
import { startAccountPayment } from "./actions";

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

  return (
    <PortalBrand token={token}>
      <AccountView
        account={account}
        returned={returned}
        statementHref={`/c/${token}/statement`}
        pay={(invoice) => (
          <PayNow
            start={startAccountPayment.bind(null, token, invoice.id)}
            balance={money(invoice.balance, invoice.currency)}
            label={`invoice #${invoice.number}`}
          />
        )}
      />
    </PortalBrand>
  );
}
