"use client";

import { ActionForm } from "@/components/ActionForm";
import { act } from "./actions";

/** Yes to exactly the list, or no with a reason the app is told. */
export function Decide({ id, name, approvable }: { id: string; name: string; approvable: boolean }) {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      {approvable ? (
        <ActionForm action={act} submit={`Approve ${name}`} hidden={{ op: "approve", id }} className="space-y-3" />
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
