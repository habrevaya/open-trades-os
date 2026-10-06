"use client";

import { ActionForm } from "@/components/ActionForm";
import { act } from "./actions";

export interface Ask {
  permission: string;
  label: string;
  held: boolean;
}

/**
 * Yes to all of it, yes to part of it, or no with a reason the app is told.
 *
 * Every permission the app asked for is a box, ticked when the person holds
 * it and not when they do not, because nobody can give an app what they do
 * not have. Unticking one leaves it out; the app is told what was left out
 * when it collects its credential, and this page says so afterwards. There is
 * no box for anything the app did not ask for.
 */
export function Decide({
  id, name, approvable, asks,
}: { id: string; name: string; approvable: boolean; asks: Ask[] }) {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      {approvable ? (
        <ActionForm action={act} submit={`Approve ${name}`} hidden={{ op: "approve", id }} className="space-y-3">
          <fieldset>
            <legend className="text-sm font-medium text-ink-700">Give it</legend>
            <p className="mt-0.5 text-xs text-ink-500">Untick anything you would rather it did not have.</p>
            <ul className="mt-2 space-y-1">
              {asks.map((ask) => (
                <li key={ask.permission}>
                  <label className="inline-flex items-start gap-2 text-sm">
                    <input type="checkbox" name="permissions" value={ask.permission}
                           defaultChecked={ask.held} disabled={!ask.held}
                           className="mt-0.5 h-4 w-4" />
                    <span>
                      {ask.label}
                      {ask.held ? null : <span className="ml-1 text-xs text-ink-500">(you do not hold this)</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </ActionForm>
      ) : null}
      <ActionForm action={act} submit="Refuse" tone="danger" hidden={{ op: "refuse", id }} className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium text-ink-700">Why, for the app (optional)</span>
          <input name="reason" maxLength={500} aria-label={`Why ${name} is being refused`}
                 className="mt-1 block h-9 w-full rounded border border-steel-300 px-2 text-sm" />
        </label>
      </ActionForm>
    </div>
  );
}
