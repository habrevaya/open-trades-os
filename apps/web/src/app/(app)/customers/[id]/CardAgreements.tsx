import { cardOnFile, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { formatDay, todayIn } from "@/lib/dates";
import { recordCardAgreement, stopCardAgreement } from "./card-agreement-actions";

/**
 * THEIR SAVED CARDS, AND WHETHER THEY LET US CHARGE THEM
 *
 * A customer saves a card in their own account; the office cannot, because a
 * card number never touches this server. What the office can do is record
 * that the customer said yes to being charged on one: on the phone, reading
 * out the product's script, or on a signed form, with the scan. It is kept
 * with the customer's own agreements, shown to them in their account where
 * they can stop it, and it is the same record the invoice's Charge button
 * looks for. Only for somebody who holds `payment:read`; the forms only for
 * somebody who may charge a saved card.
 */
export async function CardAgreements({ ctx, customerId, timezone, today }: {
  ctx: ServiceContext;
  customerId: string;
  timezone: string;
  today: string;
}) {
  if (!can(ctx.actor, "payment:read")) return null;
  const { cards } = await cardOnFile.officeCardsFor(ctx, { customerId });
  const writes = can(ctx.actor, "payment:charge_saved");
  return (
    <section aria-label="Cards on file" className="mt-10">
      <h2 className="text-base font-semibold">Cards on file</h2>
      {cards.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">
          They have not saved a card. A customer saves one from their own account; once they have, you can record
          here that they agreed to be charged on it.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {cards.map((card) => {
            const agreement = card.agreement;
            return (
              <li key={card.cardId} aria-label={card.label} className="rounded-md border border-steel-200 p-4 text-sm">
                <p className="font-medium text-ink-900">{card.label}</p>
                {agreement ? (
                  <>
                    <p className="mt-1 text-ink-700">
                      We may charge it for their bills. {agreement.wayLabel}
                      {agreement.agreedOn ? ` on ${formatDay(agreement.agreedOn, timezone)}` : `, ${formatDay(todayIn(timezone, new Date(agreement.agreedAt)), timezone)}`}
                      {agreement.takenBy ? `, taken by ${agreement.takenBy}` : ""}
                      {agreement.agreedByContact ? `, by ${agreement.agreedByContact}` : ""}.
                      {agreement.autopay ? " Their bills are paid with it automatically." : ""}
                      {agreement.autopayRank !== null && agreement.autopayRank > 1
                        ? " A backup for paying automatically: tried once, the same day, when the cards before it do not go through."
                        : ""}
                    </p>
                    {agreement.form && (
                      <p className="mt-1">
                        <a href={`/files/${agreement.form.storageKey}`} className="underline underline-offset-4">
                          The signed form ({agreement.form.fileName ?? "scan"})
                        </a>
                      </p>
                    )}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-ink-500">The words they agreed to</summary>
                      <p className="mt-1 rounded bg-steel-100 p-3 text-ink-900">{agreement.wording}</p>
                    </details>
                    {writes && (
                      <ActionForm action={stopCardAgreement} submit="They asked us to stop" tone="quiet"
                                  hidden={{ customerId, agreementId: agreement.id }} className="mt-3" />
                    )}
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-ink-500">Not agreed. We cannot charge this card without them pressing Pay.</p>
                    {writes && (
                      <div className="mt-3 space-y-3">
                        <details className="rounded border border-steel-200 p-3">
                          <summary className="cursor-pointer font-medium">Record an agreement taken by phone</summary>
                          <p className="mt-2 text-ink-700">Read this to the customer, word for word. Record it only if they say yes.</p>
                          <p className="mt-2 rounded bg-steel-100 p-3 text-ink-900">{card.wording.phone}</p>
                          <ActionForm action={recordCardAgreement} submit="Record the agreement"
                                      hidden={{ customerId, cardId: card.cardId, way: "phone", wording: card.wording.phone }}
                                      className="mt-3 space-y-3">
                            <TextField label="The day they agreed" name="agreedOn" type="date" required
                                       defaultValue={today} min={card.savedOn} max={today} className="block w-48" />
                            <label className="flex items-start gap-2">
                              <input type="checkbox" name="said" required className="mt-1" />
                              <span>I read them these words and they said yes.</span>
                            </label>
                          </ActionForm>
                        </details>
                        <details className="rounded border border-steel-200 p-3">
                          <summary className="cursor-pointer font-medium">Record an agreement on a signed form</summary>
                          <p className="mt-2 text-ink-700">The form they signed must carry these words. You need the scan to record it.</p>
                          <p className="mt-2 rounded bg-steel-100 p-3 text-ink-900">{card.wording.form}</p>
                          <ActionForm action={recordCardAgreement} submit="Record the agreement"
                                      hidden={{ customerId, cardId: card.cardId, way: "signed_form", wording: card.wording.form }}
                                      className="mt-3 space-y-3">
                            <TextField label="The day they signed" name="agreedOn" type="date" required
                                       defaultValue={today} min={card.savedOn} max={today} className="block w-48" />
                            <label className="block">
                              <span className="text-sm font-medium text-ink-700">Scan of the signed form (PDF or photo)</span>
                              <input type="file" name="form" accept="application/pdf,image/*" required
                                     className="mt-1 block text-sm" />
                            </label>
                            <label className="flex items-start gap-2">
                              <input type="checkbox" name="carries" required className="mt-1" />
                              <span>The form they signed carries these words.</span>
                            </label>
                          </ActionForm>
                        </details>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
