"use client";

import { useEffect, useRef, useState } from "react";
import { loadStripe, type StripeClient, type StripeElement, type StripeElements } from "../../../PayNow";
import type { CardSetupResult } from "./actions";
import { cardLabel } from "./card-label";

export interface CardRow {
  id: string;
  kind?: "card" | "bank_account";
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * THE CUSTOMER'S SAVED CARDS: THE LIST, REMOVING ONE, AND ADDING ONE.
 *
 * Adding one is Stripe's own element in setup mode, so the number is typed
 * into Stripe's frame and never into this page. Stripe sends the customer
 * back here with the setup's id, and the page reads the setup from Stripe
 * before it records anything. Nothing is charged by saving a card.
 */
export function SavedCards({ cards, canSave, canSaveBank = false, start, remove, notice }: {
  cards: CardRow[];
  canSave: boolean;
  /** The company takes bank payments, so a bank account can be saved too. */
  canSaveBank?: boolean;
  start: (kind: "card" | "bank_account") => Promise<CardSetupResult>;
  remove: (cardId: string) => Promise<{ ok: boolean; message?: string }>;
  /** What happened when Stripe sent the customer back, said by the page. */
  notice: { ok: boolean; text: string } | null;
}) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "saving">("idle");
  const [kind, setKind] = useState<"card" | "bank_account">("card");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<{ stripe: StripeClient; elements: StripeElements } | null>(null);
  const elementRef = useRef<StripeElement | null>(null);
  const mounted = useRef(false);

  useEffect(() => () => elementRef.current?.destroy(), []);
  useEffect(() => {
    if (state === "ready" && !mounted.current && elementRef.current && mountRef.current) {
      elementRef.current.mount(mountRef.current);
      mounted.current = true;
    }
  }, [state]);

  async function open(what: "card" | "bank_account") {
    setKind(what);
    setState("loading");
    setError(null);
    const started = await start(what);
    if (!started.ok) {
      setError(started.message);
      setState("idle");
      return;
    }
    try {
      const Stripe = await loadStripe();
      const stripe = Stripe(started.publishableKey);
      const elements = stripe.elements({ clientSecret: started.clientSecret });
      elementRef.current = elements.create("payment");
      stripeRef.current = { stripe, elements };
      mounted.current = false;
      setState("ready");
    } catch {
      setError(`The ${what === "bank_account" ? "bank account" : "card"} form could not load. Check your connection and try again.`);
      setState("idle");
    }
  }

  async function save() {
    const loaded = stripeRef.current;
    if (!loaded) return;
    setState("saving");
    setError(null);
    const { error: failed } = await loaded.stripe.confirmSetup({
      elements: loaded.elements,
      confirmParams: { return_url: window.location.href.split("?")[0]! },
    });
    // Only reached when Stripe did not send the customer back, which is a failure.
    setError(failed?.message ?? `The ${kind === "bank_account" ? "bank account" : "card"} was not saved. Nothing was charged.`);
    setState("ready");
  }

  async function drop(cardId: string) {
    setRemoving(cardId);
    setError(null);
    const result = await remove(cardId);
    if (!result.ok) setError(result.message ?? "That card could not be removed. Try again.");
    setRemoving(null);
  }

  return (
    <section aria-label="Saved cards" className="rounded-md border border-steel-200 bg-canvas p-5">
      <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">
        {canSaveBank || cards.some((c) => c.kind === "bank_account") ? "Saved cards and bank accounts" : "Saved cards"}
      </h2>
      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`mt-3 rounded px-3 py-2 text-sm ${notice.ok ? "bg-steel-100 text-ink-700" : "bg-red-tint text-red-600"}`}
        >
          {notice.text}
        </p>
      )}
      {cards.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">
          No cards saved. Save one to pay your next bill in one tap.
        </p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {cards.map((card) => (
            <li key={card.id} className="flex items-center justify-between gap-4">
              <span>
                {cardLabel(card)}
                {card.kind !== "bank_account" && card.expMonth && card.expYear && (
                  <span className="text-ink-500">, expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => void drop(card.id)}
                disabled={removing !== null}
                className="text-sm text-ink-700 underline underline-offset-4 disabled:opacity-40"
              >
                {removing === card.id ? "Removing…" : `Remove ${cardLabel(card)}`}
              </button>
            </li>
          ))}
        </ul>
      )}

      {canSave && (state === "idle" || state === "loading") && (
        <button
          type="button"
          onClick={() => void open("card")}
          disabled={state === "loading"}
          className="mt-4 h-11 w-full rounded border border-steel-300 text-sm font-medium transition-colors hover:bg-steel-100 disabled:opacity-40"
        >
          {state === "loading" && kind === "card" ? "Opening…" : "Save a card"}
        </button>
      )}
      {canSaveBank && (state === "idle" || state === "loading") && (
        <>
          <button
            type="button"
            onClick={() => void open("bank_account")}
            disabled={state === "loading"}
            className="mt-2 h-11 w-full rounded border border-steel-300 text-sm font-medium transition-colors hover:bg-steel-100 disabled:opacity-40"
          >
            {state === "loading" && kind === "bank_account" ? "Opening…" : "Save a bank account"}
          </button>
          <p className="mt-1 text-center text-xs text-ink-500">
            You sign in to your bank to check the account. A payment from a bank account takes a few business days to arrive.
          </p>
        </>
      )}
      {(state === "ready" || state === "saving") && (
        <div className="mt-4">
          <div ref={mountRef} className="min-h-[120px]" />
          <button
            type="button"
            onClick={() => void save()}
            disabled={state === "saving"}
            style={{ backgroundColor: "var(--brand, #111827)", color: "var(--brand-on, #ffffff)" }}
            className="mt-4 h-12 w-full rounded text-base font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {state === "saving" ? "Saving…" : kind === "bank_account" ? "Save this bank account" : "Save this card"}
          </button>
          <p className="mt-2 text-center text-xs text-ink-500">
            {kind === "bank_account"
              ? "Bank details go straight to Stripe and never reach this site. Saving a bank account takes nothing from it; by paying from it later you allow that one payment to be taken."
              : "Card details go straight to Stripe and never reach this site. Saving a card charges nothing."}
          </p>
        </div>
      )}
      {error && <p className="mt-3 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
