"use client";

import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { declineFinding } from "./actions";

/**
 * "The customer said no", on a backlog row: why, from the fixed list, and their
 * own words if there are any. The code is what plumbing's water heater capture
 * reads; the words are kept beside it and never read for a meaning.
 */
export function DeclineForm({ deficiencyId, codes }: { deficiencyId: string; codes: { value: string; label: string }[] }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-ink-700 underline underline-offset-4">The customer said no</summary>
      <ActionForm action={declineFinding} submit="Record it" tone="quiet" hidden={{ deficiencyId }}
                  className="mt-2 flex flex-wrap items-end gap-3">
        <Select label="Why" name="declineCode" required defaultValue="" className="block w-72"
                options={[{ value: "", label: "Choose" }, ...codes]} />
        <TextField label="Their words, if any" name="reason" className="block w-72" />
      </ActionForm>
    </details>
  );
}
