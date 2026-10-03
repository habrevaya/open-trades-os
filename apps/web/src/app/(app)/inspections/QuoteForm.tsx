"use client";

import { ActionForm } from "@/components/ActionForm";
import { quoteFinding } from "./actions";

/** The one button on a backlog row, with a price box for a finding whose checkpoint declares no repair. */
export function QuoteForm({ deficiencyId, needsPrice }: { deficiencyId: string; needsPrice: boolean }) {
  return (
    <ActionForm action={quoteFinding} submit="Quote it" tone="quiet" hidden={{ deficiencyId }} className="mt-2 flex flex-wrap items-end gap-2">
      {needsPrice && (
        <label className="text-xs text-ink-700">Price to correct it
          <input name="price" inputMode="decimal" className="ml-1 h-8 w-24 rounded border border-steel-300 px-2 text-sm" />
        </label>
      )}
    </ActionForm>
  );
}
