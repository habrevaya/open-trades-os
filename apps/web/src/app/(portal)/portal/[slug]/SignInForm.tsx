"use client";

import { useState } from "react";
import { checkCode, sendCode, type SignInStep } from "./actions";

const input = "mt-1 h-12 w-full rounded border border-steel-300 px-3 text-base";
const button = "h-12 w-full rounded text-base font-medium transition-opacity hover:opacity-90 disabled:opacity-40";
const brand = { backgroundColor: "var(--brand, #111827)", color: "var(--brand-on, #ffffff)" } as const;

/**
 * Signing in, in two steps and sometimes three.
 *
 * The address, then the code, then (only when the address is on two
 * customer records) which account. Nothing is remembered between visits
 * except the sign in itself, which is a cookie the page never sees.
 *
 * The press of "Send me a code" carries a key made when the page loaded, so
 * a double tap on a phone with one bar sends one code rather than two, the
 * second of which would kill the first while the customer is reading it.
 */
export function SignInForm({ slug, organizationName }: { slug: string; organizationName: string }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"address" | "code" | "choose">("address");
  const [accounts, setAccounts] = useState<{ id: string; name: string; place: string | null }[]>([]);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(10);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());

  const handle = (result: SignInStep | undefined) => {
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if ("sent" in result) {
      setMinutes(result.expiresInMinutes);
      setStep("code");
    } else {
      setAccounts(result.choose);
      setStep("choose");
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    handle(await sendCode(slug, address, requestKey));
    setBusy(false);
  };

  const check = async (customerId?: string) => {
    setBusy(true);
    setError(null);
    // Signing in redirects; anything that comes back is a refusal or a choice.
    handle(await checkCode(slug, address, code, customerId));
    setBusy(false);
  };

  const again = () => {
    setStep("address");
    setCode("");
    setError(null);
    setRequestKey(crypto.randomUUID());
  };

  return (
    <div className="space-y-4 rounded-md border border-steel-200 bg-canvas p-5">
      {step === "address" && (
        <form
          className="space-y-4"
          onSubmit={(event) => { event.preventDefault(); void send(); }}
        >
          <label className="block">
            <span className="text-sm font-medium">Email or mobile number</span>
            <input
              className={input}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              autoComplete="username"
              inputMode="email"
              required
            />
            <span className="mt-1 block text-xs text-ink-500">
              The one {organizationName} has for you. We will send a code there.
            </span>
          </label>
          <button type="submit" disabled={busy || address.trim() === ""} style={brand} className={button}>
            {busy ? "Sending…" : "Send me a code"}
          </button>
        </form>
      )}

      {step === "code" && (
        <form
          className="space-y-4"
          onSubmit={(event) => { event.preventDefault(); void check(); }}
        >
          <p role="status" className="text-sm text-ink-700">
            If {address.trim()} is the address {organizationName} has for you, a six digit code is on its
            way. It works once, for {minutes} minutes.
          </p>
          <label className="block">
            <span className="text-sm font-medium">Code</span>
            <input
              className={`${input} font-mono tracking-[0.3em]`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={9}
              required
            />
          </label>
          <button type="submit" disabled={busy || code.trim() === ""} style={brand} className={button}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <p className="text-center text-sm text-ink-700">
            Nothing arrived?{" "}
            <button type="button" onClick={again} className="underline underline-offset-4">
              Send a new code
            </button>
            . If it still does not come, contact {organizationName}: they may have a different address for you.
          </p>
        </form>
      )}

      {step === "choose" && (
        <form
          className="space-y-4"
          onSubmit={(event) => { event.preventDefault(); void check(chosen); }}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">That address is on more than one account. Which one?</legend>
            {accounts.map((account) => (
              <label key={account.id} className="flex items-start gap-3 rounded border border-steel-200 p-3">
                <input
                  type="radio"
                  name="account"
                  value={account.id}
                  checked={chosen === account.id}
                  onChange={() => setChosen(account.id)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">{account.name}</span>
                  {account.place && <span className="block text-sm text-ink-500">{account.place}</span>}
                </span>
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy || chosen === ""} style={brand} className={button}>
            {busy ? "Signing in…" : "Continue"}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
