import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { PortalBrand } from "../../PortalBrand";
import { PayNow } from "../../PayNow";
import { DepositView, money, type DepositViewData } from "./DepositView";
import { startDepositPayment } from "./actions";

export const dynamic = "force-dynamic";

/**
 * A deposit, from the link an approved estimate hands back.
 *
 * The link used to be `/pay/{deposit id}` with nothing behind it. It is a
 * token now, minted and resolved exactly as the invoice link is: peeked to
 * read, consumed to pay, and every failure (expired, revoked, never issued,
 * a suspended company) is the same 404, so the page does not say which
 * tokens were real.
 */
export default async function DepositPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;

  let deposit: DepositViewData;
  try {
    deposit = await portalAccount.viewDeposit(getDb(), { token });
  } catch {
    notFound();
  }
  const returned = typeof query["redirect_status"] === "string" ? query["redirect_status"] : null;

  return (
    <PortalBrand token={token}>
      <DepositView
        deposit={deposit}
        returned={returned}
        pay={(
          <PayNow
            start={startDepositPayment.bind(null, token)}
            balance={money(deposit.outstanding, deposit.currency)}
          />
        )}
      />
    </PortalBrand>
  );
}
