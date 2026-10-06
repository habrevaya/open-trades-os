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
  /** Whether the customer lets the company charge it, and pays bills automatically with it. */
  agreement?: { agreedAt: string; autopay: boolean; agreedByContact: string | null } | null;
  /** The words they would agree to, exactly as the server checks them. */
  wording?: { agreement: string; autopay: string };
}

export type AgreementResult = { ok: true } | { ok: false; message: string };

export interface AgreementActions {
  agree: (cardId: string, wording: string) => Promise<AgreementResult>;
  autopay: (cardId: string, on: boolean, wording?: string) => Promise<AgreementResult>;
  withdraw: (cardId: string) => Promise<AgreementResult>;
}

/**
 * THE CUSTOMER'S SAVED CARDS: THE LIST, REMOVING ONE, AND ADDING ONE.
 *
 * Adding one is Stripe's own element in setup mode, so the number is typed
 * into Stripe's frame and never into this page. Stripe sends the customer
 * back here with the setup's id, and the page reads the setup from Stripe
 * before it records anything. Nothing is charged by saving a card.
 */
export function SavedCards({ cards, canSave, canSaveBank = false, start, remove, notice, agreements, company }: {
  cards: CardRow[];
  canSave: boolean;
  /** The company takes bank payments, so a bank account can be saved too. */
  canSaveBank?: boolean;
  start: (kind: "card" | "bank_account") => Promise<CardSetupResult>;
  remove: (cardId: string) => Promise<{ ok: boolean; message?: string }>;
  /** What happened when Stripe sent the customer back, said by the page. */
  notice: { ok: boolean; text: string } | null;
  /** Letting the company charge a card, paying automatically, and stopping. Absent, none is offered. */
  agreements?: AgreementActions | undefined;
  company?: string | undefined;
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
        <ul className="mt-3 space-y-4 text-sm">
          {cards.map((card) => (
            <li key={card.id}>
              <div className="flex items-center justify-between gap-4">
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
              </div>
              {agreements && card.wording && (
                <CardAgreement card={card} wording={card.wording} actions={agreements} company={company ?? "The company"} />
              )}
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

/**
 * LETTING THE COMPANY CHARGE ONE CARD, AND PAYING BILLS AUTOMATICALLY WITH IT
 *
 * The words are the server's, shown exactly, and sent back with the yes: the
 * server builds them again and stores them only if they match, so what is
 * kept is what the customer read. A box to tick, then a button, because a
 * yes to being charged with nobody on the page should take a deliberate
 * second step. Paying automatically is a second yes, with its own words.
 * Stopping either is one press.
 */
function CardAgreement({ card, wording, actions, company }: {
  card: CardRow;
  wording: { agreement: string; autopay: string };
  actions: AgreementActions;
  company: string;
}) {
  const [open, setOpen] = useState<"agree" | "autopay" | null>(null);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = cardLabel(card);
  const agreement = card.agreement ?? null;

  async function run(work: () => Promise<AgreementResult>) {
    setBusy(true);
    setError(null);
    const result = await work();
    setBusy(false);
    if (!result.ok) setError(result.message);
    else { setOpen(null); setTicked(false); }
  }

  const words = open === "autopay" ? wording.autopay : wording.agreement;
  return (
    <div className="mt-2 rounded border border-steel-200 p-3">
      {agreement ? (
        <>
          <p className="text-ink-700">
            {company} may charge {label} for your bills
            {agreement.agreedByContact ? ` (agreed by ${agreement.agreedByContact})` : ""}.
            {agreement.autopay ? " Your bills are paid with it automatically when they are issued." : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {agreement.autopay ? (
              <button type="button" disabled={busy} onClick={() => void run(() => actions.autopay(card.id, false))}
                      className="text-sm text-ink-700 underline underline-offset-4 disabled:opacity-40">
                Stop paying automatically
              </button>
            ) : open !== "autopay" && (
              <button type="button" disabled={busy} onClick={() => { setOpen("autopay"); setTicked(false); }}
                      className="text-sm text-ink-700 underline underline-offset-4 disabled:opacity-40">
                Pay my bills automatically with {label}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void run(() => actions.withdraw(card.id))}
                    className="text-sm text-ink-700 underline underline-offset-4 disabled:opacity-40">
              Stop {company} charging {label}
            </button>
          </div>
        </>
      ) : open !== "agree" && (
        <button type="button" onClick={() => { setOpen("agree"); setTicked(false); }}
                className="text-sm text-ink-700 underline underline-offset-4">
          Let {company} charge {label} for my bills
        </button>
      )}
      {open && (
        <div className="mt-3">
          <p className="rounded bg-steel-100 p-3 text-ink-900">{words}</p>
          <label className="mt-2 flex items-start gap-2">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-1" />
            <span>I have read this and I agree.</span>
          </label>
          <div className="mt-2 flex gap-3">
            <button type="button" disabled={!ticked || busy}
                    onClick={() => void run(() => (open === "agree" ? actions.agree(card.id, words) : actions.autopay(card.id, true, words)))}
                    style={{ backgroundColor: "var(--brand, #111827)", color: "var(--brand-on, #ffffff)" }}
                    className="h-10 rounded px-4 text-sm font-medium disabled:opacity-40">
              {busy ? "Saving…" : open === "agree" ? "Agree" : "Turn on automatic payments"}
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(null)}
                    className="text-sm text-ink-700 underline underline-offset-4">
              Not now
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
