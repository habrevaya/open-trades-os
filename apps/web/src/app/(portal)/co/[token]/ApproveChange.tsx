"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { approveChange, declineChange } from "./actions";

/**
 * Signing a change order. Typing a name signs it, as it does an estimate,
 * and the page says what that does to the contract right above the button.
 */
export function ApproveChange({ token, effect }: { token: string; effect: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);

  async function onApprove() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const result = await approveChange({ token, signerName: name.trim() });
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-steel-200 bg-canvas p-5">
        <p className="text-sm text-ink-700">{effect}</p>
        <label className="mt-4 block">
          <span className="text-sm font-medium">Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Type your full name to sign"
            autoComplete="name"
            className="mt-1 h-12 w-full rounded border border-steel-300 px-3 text-base"
          />
        </label>
        <p className="mt-2 text-xs text-ink-500">
          Typing your name signs this change order. We record the date, this device and exactly what the page said.
        </p>
        {error && <p role="alert" className="mt-3 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>}
        <button
          type="button"
          onClick={onApprove}
          disabled={busy || !name.trim()}
          style={{ backgroundColor: "var(--brand, #111827)", color: "var(--brand-on, #ffffff)" }}
          className="mt-5 h-12 w-full rounded text-base font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Approving" : "Approve and sign"}
        </button>
      </div>

      <div className="pt-2 text-center">
        {declining ? (
          <form action={declineChange} className="mx-auto max-w-md space-y-3 text-left">
            <input type="hidden" name="token" value={token} />
            <label className="block">
              <span className="text-sm font-medium">Anything you can tell us? Optional.</span>
              <textarea name="reason" rows={3} className="mt-1 w-full rounded border border-steel-300 p-3 text-base" />
            </label>
            <button type="submit" className="h-11 w-full rounded border border-steel-300 bg-canvas text-base font-medium">
              Decline this change
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setDeclining(true)} className="text-sm text-ink-500 underline underline-offset-4">
            No thanks
          </button>
        )}
      </div>
    </div>
  );
}
