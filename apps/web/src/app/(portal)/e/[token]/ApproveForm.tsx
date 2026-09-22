"use client";

import { useState } from "react";
import { approve, decline } from "./actions";

type Estimate = {
  number: number;
  options: Array<{
    id: string;
    name: string;
    description: string | null;
    isRecommended: boolean;
    total: string;
    baseTotal: string;
    lines: Array<{
      id: string;
      name: string;
      description: string | null;
      quantity: string;
      lineTotal: string;
      isOptional: boolean;
      isSelected: boolean;
    }>;
  }>;
};

const dollars = (v: string) =>
  Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Choosing and signing.
 *
 * The options are already in the order the server decided: most expensive
 * first, with any recommended one pulled up. Re-sorting here would undo that,
 * and cheapest-first anchors the customer on the cheapest, which is the whole
 * reason there are three of them.
 *
 * Nothing is pre-selected. A pre-ticked option is a default the customer did
 * not choose, and on a document they are about to sign that is worse than an
 * extra click.
 */
export function ApproveForm({ token, estimate }: { token: string; estimate: Estimate }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [extras, setExtras] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);

  const option = estimate.options.find((o) => o.id === chosen);
  const optionalLines = option?.lines.filter((l) => l.isOptional) ?? [];

  const total = option
    ? Number(option.baseTotal) +
      optionalLines
        .filter((l) => extras.has(l.id))
        .reduce((sum, l) => sum + Number(l.lineTotal), 0)
    : 0;

  const toggleExtra = (id: string) =>
    setExtras((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function onApprove() {
    if (!chosen || !name.trim()) return;
    setBusy(true);
    setError(null);
    const result = await approve({
      token, optionId: chosen, selectedLineIds: [...extras], signerName: name.trim(),
    });
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {estimate.options.map((o) => {
        const selected = o.id === chosen;
        return (
          <div
            key={o.id}
            className={`rounded-md border bg-canvas transition-colors ${
              selected ? "border-ink-900 ring-1 ring-ink-900" : "border-steel-200"
            }`}
          >
            <button
              type="button"
              onClick={() => { setChosen(o.id); setExtras(new Set()); }}
              className="flex w-full items-start justify-between gap-4 p-5 text-left"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{o.name}</span>
                  {o.isRecommended && (
                    <span className="rounded bg-ink-900 px-1.5 py-0.5 text-xs font-medium text-white">
                      Recommended
                    </span>
                  )}
                </div>
                {o.description && (
                  <p className="mt-1 text-sm text-ink-700">{o.description}</p>
                )}
              </div>
              <span className="shrink-0 font-mono text-lg font-semibold tabular-nums">
                {dollars(o.baseTotal)}
              </span>
            </button>

            {selected && (
              <div className="border-t border-steel-200 px-5 py-4">
                <ul className="space-y-2 text-sm">
                  {o.lines.filter((l) => !l.isOptional).map((l) => (
                    <li key={l.id} className="flex justify-between gap-4">
                      <span className="text-ink-700">
                        {Number(l.quantity) !== 1 && `${Number(l.quantity)} × `}
                        {l.name}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-ink-500">
                        {dollars(l.lineTotal)}
                      </span>
                    </li>
                  ))}
                </ul>

                {optionalLines.length > 0 && (
                  <div className="mt-4 border-t border-steel-200 pt-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-ink-500">
                      Add if you want it
                    </p>
                    <ul className="mt-2 space-y-2">
                      {optionalLines.map((l) => (
                        <li key={l.id}>
                          <label className="flex cursor-pointer items-start gap-3 text-sm">
                            <input
                              type="checkbox"
                              checked={extras.has(l.id)}
                              onChange={() => toggleExtra(l.id)}
                              className="mt-1 h-4 w-4"
                            />
                            <span className="flex-1">
                              <span className="font-medium">{l.name}</span>
                              {l.description && (
                                <span className="block text-ink-700">{l.description}</span>
                              )}
                            </span>
                            <span className="shrink-0 font-mono tabular-nums">
                              {dollars(l.lineTotal)}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {option && (
        <div className="rounded-md border border-steel-200 bg-canvas p-5">
          <div className="flex items-baseline justify-between">
            <span className="font-medium">Total</span>
            <span className="font-mono text-2xl font-semibold tabular-nums">
              {dollars(String(total))}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-500">Includes tax.</p>

          <label className="mt-5 block">
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
            Typing your name signs this estimate. We record the date, the option you chose
            and this device.
          </p>

          {error && (
            <p className="mt-3 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          <button
            type="button"
            onClick={onApprove}
            disabled={busy || !name.trim()}
            className="mt-5 h-12 w-full rounded bg-ink-900 text-base font-medium text-white transition-colors hover:bg-ink-700 disabled:opacity-40"
          >
            {busy ? "Approving…" : `Approve ${option.name}`}
          </button>
        </div>
      )}

      <div className="pt-2 text-center">
        {declining ? (
          <form action={decline} className="mx-auto max-w-md space-y-3 text-left">
            <input type="hidden" name="token" value={token} />
            <label className="block">
              <span className="text-sm font-medium">
                Anything you can tell us? Optional.
              </span>
              <textarea
                name="reason"
                rows={3}
                className="mt-1 w-full rounded border border-steel-300 p-3 text-base"
                placeholder="Price, timing, going a different direction…"
              />
            </label>
            <button
              type="submit"
              className="h-11 w-full rounded border border-steel-300 bg-canvas text-base font-medium"
            >
              Decline this estimate
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setDeclining(true)}
            className="text-sm text-ink-500 underline underline-offset-4"
          >
            No thanks
          </button>
        )}
      </div>
    </div>
  );
}
