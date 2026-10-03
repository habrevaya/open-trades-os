"use client";

import { useState } from "react";
import { PayNow, loadStripe } from "./PayNow";
import type { StartPayment } from "./start-payment";

export interface TipOffer {
  available: boolean;
  presets: { percent: number; amount: string }[];
  for: string[];
}

export type SavedCardPay =
  | { ok: true; status: string; clientSecret: string; publishableKey: string | null }
  | { ok: false; message: string };

const money = (value: number, currency: string) =>
  value.toLocaleString("en-US", { style: "currency", currency });

/** Cents, so adding a tip to a balance is integer arithmetic and never a float drifting. */
const cents = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
};

const names = (people: string[]) =>
  people.length <= 1 ? (people[0] ?? "") : `${people.slice(0, -1).join(", ")} and ${people.at(-1)}`;

/**
 * PAYING ONE INVOICE, WITH A TIP IF THE COMPANY TAKES THEM AND A SAVED CARD
 * IF THE CUSTOMER HAS ONE.
 *
 * The tip is chosen first, because it changes the amount the processor is
 * asked for: the card form is opened for the balance and the tip together,
 * and choosing a different tip after that starts the form again rather than
 * charging an amount the customer no longer sees on screen. The total shown
 * here is for the customer to read; the server works it out again from the
 * invoice's balance and refuses a tip the company would not take.
 *
 * Nothing here marks anything paid. A saved card is confirmed on the spot
 * and the invoice changes when the processor's signed webhook arrives, the
 * same as a new card.
 */
export function PayInvoice({
  balance, currency, label, tipping, start, savedCards = [], payWithSaved,
}: {
  /** The balance, as the decimal string the server sent. */
  balance: string;
  currency: string;
  label?: string;
  tipping: TipOffer;
  /** A server action bound to whatever reaches the invoice, taking the tip as typed. */
  start: (options: { tip?: string }) => Promise<StartPayment>;
  savedCards?: { id: string; label: string }[];
  payWithSaved?: (cardId: string, options: { tip?: string }) => Promise<SavedCardPay>;
}) {
  const [choice, setChoice] = useState<string>("none");
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const due = cents(Number(balance).toFixed(2)) ?? 0;
  const tipCents = !tipping.available || choice === "none"
    ? 0
    : choice === "other"
      ? cents(other)
      : cents(Number(tipping.presets.find((p) => String(p.percent) === choice)?.amount ?? "0").toFixed(2));
  const tipValid = tipCents !== null;
  const tip = tipValid ? (tipCents / 100).toFixed(2) : "";
  const total = money((due + (tipCents ?? 0)) / 100, currency);

  async function saved(cardId: string) {
    if (!payWithSaved) return;
    setBusy(true);
    setError(null);
    const result = await payWithSaved(cardId, tipCents ? { tip } : {});
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    if (result.status === "requires_action") {
      /**
       * The bank wants the cardholder to confirm. Stripe shows its own
       * screen for that and comes back here; the payment still lands
       * through the webhook either way.
       */
      try {
        if (!result.publishableKey) throw new Error("no key");
        const Stripe = await loadStripe();
        const { error: failed } = await Stripe(result.publishableKey).handleNextAction({
          clientSecret: result.clientSecret,
        });
        if (failed) {
          setError(failed.message ?? "Your bank did not confirm the payment. You have not been charged.");
          setBusy(false);
          return;
        }
      } catch {
        setError("Your bank wants to confirm this payment and the check could not load. Try again.");
        setBusy(false);
        return;
      }
    }
    setDone(result.status === "processing"
      ? "Your payment is processing. It will show here once your bank confirms it."
      : "Thank you. Your payment went through and will show here in a moment.");
    setBusy(false);
  }

  if (done) {
    return (
      <p role="status" className="rounded-md border border-steel-200 bg-canvas p-4 text-center text-sm text-ink-700">
        {done}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {tipping.available && (
        <fieldset className="rounded-md border border-steel-200 bg-canvas p-4">
          <legend className="px-1 text-sm font-medium">
            Add a tip{tipping.for.length > 0 ? ` for ${names(tipping.for)}` : ""}?
          </legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {[{ key: "none", text: "No tip" },
              ...tipping.presets.map((p) => ({ key: String(p.percent), text: `${p.percent}% (${money(Number(p.amount), currency)})` })),
              { key: "other", text: "Other amount" }].map((option) => (
              <label
                key={option.key}
                className={`cursor-pointer rounded border px-3 py-2 text-sm ${choice === option.key ? "border-ink-900 bg-steel-100" : "border-steel-300"}`}
              >
                <input
                  type="radio"
                  name={`tip-${label ?? "invoice"}`}
                  value={option.key}
                  checked={choice === option.key}
                  onChange={() => setChoice(option.key)}
                  className="sr-only"
                />
                {option.text}
              </label>
            ))}
          </div>
          {choice === "other" && (
            <label className="mt-3 block">
              <span className="text-sm">Tip amount</span>
              <input
                value={other}
                onChange={(event) => setOther(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="mt-1 h-11 w-40 rounded border border-steel-300 px-3 font-mono text-base"
              />
            </label>
          )}
          {!tipValid && (
            <p className="mt-2 text-sm text-red-600">A tip is dollars and cents, like 15 or 12.50.</p>
          )}
          <p className="mt-3 text-xs text-ink-500">
            Every cent of a tip goes to the technicians who did the work.
          </p>
        </fieldset>
      )}

      {savedCards.length > 0 && payWithSaved && (
        <div className="space-y-2 rounded-md border border-steel-200 bg-canvas p-4">
          {savedCards.map((card) => (
            <button
              key={card.id}
              type="button"
              disabled={busy || !tipValid}
              onClick={() => void saved(card.id)}
              style={{ backgroundColor: "var(--brand, #111827)", color: "var(--brand-on, #ffffff)" }}
              className="h-12 w-full rounded text-base font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Paying…" : `Pay ${total} with ${card.label}`}
            </button>
          ))}
          {error && <p className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>}
          <p className="text-center text-xs text-ink-500">Or pay with a different card below.</p>
        </div>
      )}

      {tipValid && (
        <PayNow
          /*
            Keyed on the tip, so a different tip opens a fresh card form for
            the new amount rather than charging the one opened before.
          */
          key={tip}
          start={() => start(tipCents ? { tip } : {})}
          balance={total}
          {...(label ? { label } : {})}
        />
      )}
    </div>
  );
}
