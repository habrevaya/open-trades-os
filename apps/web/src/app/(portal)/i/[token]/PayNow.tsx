"use client";

import { useEffect, useRef, useState } from "react";
import { startPayment } from "./actions";

/**
 * The slice of Stripe.js this page uses. Typed here rather than pulled in as
 * a dependency: Stripe requires the library to be loaded from its own domain
 * anyway, so a package would only be a loader for this one script tag.
 */
interface StripeElement { mount(target: HTMLElement): void; destroy(): void }
interface StripeElements { create(kind: "payment"): StripeElement }
interface StripeClient {
  elements(options: { clientSecret: string }): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    confirmParams: { return_url: string };
  }): Promise<{ error?: { message?: string } }>;
}
declare global {
  interface Window { Stripe?: (key: string) => StripeClient }
}

const STRIPE_JS = "https://js.stripe.com/v3/";

function loadStripe(): Promise<NonNullable<Window["Stripe"]>> {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_JS}"]`);
    const script = existing ?? Object.assign(document.createElement("script"), { src: STRIPE_JS });
    script.addEventListener("load", () => (window.Stripe ? resolve(window.Stripe) : reject()));
    script.addEventListener("error", () => reject());
    if (!existing) document.head.appendChild(script);
  });
}

/**
 * Pay now, with Stripe's Payment Element.
 *
 * Nothing is started until the customer asks: opening the page creates no
 * payment intent, so a customer who only wanted to read the invoice leaves
 * nothing behind in the company's Stripe account. The amount is the balance
 * the server read from the invoice, never a number from this component.
 *
 * Paying does not mark anything paid here. Stripe returns the customer to
 * this page, and the balance changes when the processor's signed webhook
 * says the money moved.
 */
export function PayNow({ token, balance }: { token: string; balance: string }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "paying">("idle");
  const [error, setError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<{ stripe: StripeClient; elements: StripeElements } | null>(null);
  const elementRef = useRef<StripeElement | null>(null);

  useEffect(() => () => elementRef.current?.destroy(), []);

  async function open() {
    setState("loading");
    setError(null);
    const started = await startPayment(token);
    if (!started.ok) {
      setError(started.message);
      setState("idle");
      return;
    }
    try {
      const Stripe = await loadStripe();
      const stripe = Stripe(started.publishableKey);
      const elements = stripe.elements({ clientSecret: started.clientSecret });
      const element = elements.create("payment");
      stripeRef.current = { stripe, elements };
      elementRef.current = element;
      setState("ready");
      // Mounted after the container renders.
      requestAnimationFrame(() => {
        if (mountRef.current) element.mount(mountRef.current);
      });
    } catch {
      setError("The card form could not load. Check your connection and try again.");
      setState("idle");
    }
  }

  async function pay() {
    const loaded = stripeRef.current;
    if (!loaded) return;
    setState("paying");
    setError(null);
    const { error: failed } = await loaded.stripe.confirmPayment({
      elements: loaded.elements,
      confirmParams: { return_url: window.location.href.split("?")[0]! },
    });
    // Only reached when the confirmation did not redirect, which is a failure.
    setError(failed?.message ?? "That payment did not go through. You have not been charged.");
    setState("ready");
  }

  const button = {
    backgroundColor: "var(--brand, #111827)",
    color: "var(--brand-on, #ffffff)",
  } as const;

  return (
    <div className="rounded-md border border-steel-200 bg-canvas p-5">
      {state === "idle" || state === "loading" ? (
        <button
          type="button"
          onClick={open}
          disabled={state === "loading"}
          style={button}
          className="h-12 w-full rounded text-base font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {state === "loading" ? "Opening…" : `Pay ${balance} now`}
        </button>
      ) : (
        <>
          <div ref={mountRef} className="min-h-[120px]" />
          <button
            type="button"
            onClick={pay}
            disabled={state === "paying"}
            style={button}
            className="mt-5 h-12 w-full rounded text-base font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {state === "paying" ? "Paying…" : `Pay ${balance}`}
          </button>
        </>
      )}
      {error && (
        <p className="mt-3 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>
      )}
      <p className="mt-3 text-center text-xs text-ink-500">
        Card details go straight to Stripe and never reach this site.
      </p>
    </div>
  );
}
