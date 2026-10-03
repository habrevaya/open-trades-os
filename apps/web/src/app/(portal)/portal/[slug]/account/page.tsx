import { getDb } from "@/lib/db";
import { portalAccount, referrals, savedCards } from "@opentradesos/api/services";
import { requirePortalSession } from "@/lib/portal-session";
import { PortalBrand } from "../../../PortalBrand";
import { PayInvoice } from "../../../PayInvoice";
import { AccountView } from "../../../c/[token]/AccountView";
import { ReferralBlock } from "../../../c/[token]/ReferralBlock";
import { SavedCards, cardLabel } from "./SavedCards";
import {
  openRecord, payWithSavedCard, removeCard, signOut, startCardSetup, startSessionPayment,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * A SIGNED IN CUSTOMER'S ACCOUNT
 *
 * The same account the `/c/{token}` link shows, built by the same service
 * and drawn by the same view, with three things only a sign in gets: saved
 * cards, a way to open each estimate, job and invoice on its own page, and
 * signing out. Every action on the page is bound to the company's slug and
 * reads the sign in from its cookie on the server, so the token never
 * reaches the browser in any form a script could read.
 */
export default async function SignedInAccountPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const session = await requirePortalSession(slug);
  const db = getDb();
  const token = session.token;

  /**
   * Stripe sends the customer back here after saving a card, with the
   * setup's id. That id is a claim from the browser; the service reads the
   * setup from Stripe and records the card only if Stripe says it was saved
   * for this customer. Recording it twice records it once, so a refresh of
   * this page is harmless.
   */
  let notice: { ok: boolean; text: string } | null = null;
  const setupId = typeof query["setup_intent"] === "string" ? query["setup_intent"] : null;
  if (setupId) {
    notice = await savedCards.confirmSave(db, { token, setupId })
      .then((card) => ({ ok: true, text: `${cardLabel(card)} is saved.` }))
      .catch((error: unknown) => ({
        ok: false,
        text: error instanceof Error && error.name === "ConflictError"
          ? error.message
          : "That card could not be saved. Nothing was charged. Try adding it again.",
      }));
  }

  const [account, cards, referral] = await Promise.all([
    portalAccount.viewAccount(db, { token }),
    savedCards.list(db, { token }),
    referrals.forPortal(db, { token }).catch(() => null),
  ]);
  const returned = typeof query["redirect_status"] === "string" && !setupId ? query["redirect_status"] : null;
  const usable = cards.cards.map((card) => ({ id: card.id, label: cardLabel(card) }));
  const base = `/portal/${encodeURIComponent(slug)}`;

  return (
    <PortalBrand token={token} logoHref={`${base}/logo`}>
      <AccountView
        account={account}
        returned={returned}
        closing={`Questions? Call or text ${account.organizationName}, or reply to any message from them.`}
        statementHref={`${base}/account/statement`}
        pdfHref={(invoiceId) => `${base}/account/invoices/${invoiceId}/pdf`}
        changeHref={(visitId) => `${base}/account/change/${visitId}`}
        top={(
          <form action={signOut.bind(null, slug)} className="mt-2">
            <button type="submit" className="text-sm text-ink-700 underline underline-offset-4">
              Sign out
            </button>
          </form>
        )}
        open={(kind, id, label) => (
          <form action={openRecord.bind(null, slug, kind, id)} className="inline">
            <button type="submit" className="text-xs text-blue-600 underline underline-offset-4">{label}</button>
          </form>
        )}
        pay={(invoice) => (
          <PayInvoice
            start={startSessionPayment.bind(null, slug, invoice.id)}
            balance={invoice.balance}
            currency={invoice.currency}
            tipping={invoice.tipping}
            label={`invoice #${invoice.number}`}
            savedCards={usable}
            payWithSaved={payWithSavedCard.bind(null, slug, invoice.id)}
          />
        )}
        after={(
          <SavedCards
            cards={cards.cards}
            canSave={cards.canSave}
            start={startCardSetup.bind(null, slug)}
            remove={removeCard.bind(null, slug)}
            notice={notice}
          />
        )}
      />
      {referral ? <ReferralBlock referral={referral} /> : null}
    </PortalBrand>
  );
}
