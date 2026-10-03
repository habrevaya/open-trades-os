"use client";

import { ActionForm } from "@/components/ActionForm";
import { act } from "./actions";

/**
 * Taking a phone away. Says what it does on the button, because it cannot be
 * undone from here: the person signs in again on a phone they still have.
 */
export function Revoke({ id, label }: { id: string; label: string }) {
  return (
    <ActionForm action={act} submit={`Take away ${label}`} tone="danger" hidden={{ op: "revoke", id }}
                className="mt-0" />
  );
}

/** The number a sign in code is texted to. Empty clears it, and codes then go by email only. */
export function Mobile({ id, name, current }: { id: string; name: string; current: string | null }) {
  return (
    <ActionForm action={act} submit="Save number" tone="quiet" hidden={{ op: "mobile", id }}
                className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="sr-only">Mobile number for {name}</span>
        <input name="mobilePhone" defaultValue={current ?? ""} inputMode="tel" placeholder="(512) 555-0100"
               aria-label={`Mobile number for ${name}`}
               className="h-9 w-48 rounded border border-steel-300 bg-canvas px-3 text-sm" />
      </label>
    </ActionForm>
  );
}
