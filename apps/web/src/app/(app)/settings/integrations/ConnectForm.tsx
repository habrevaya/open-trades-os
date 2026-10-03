"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useState } from "react";
import { connect, disconnect, type ActionState } from "./actions";
import type { ProviderForm } from "./fields";

const input = "h-10 w-full rounded border border-steel-300 px-3 text-sm";

/**
 * Connect, edit or disconnect one provider.
 *
 * Collapsed until asked for, because a page of thirty open forms is a page
 * nobody can find anything on. Stored values are never shown back: a field
 * left blank keeps what is stored, which the form says, so an empty box is
 * never mistaken for "this was never set".
 */
export function ConnectForm({
  provider, label, form, connected, saved = connected, credentialRef,
}: {
  provider: string;
  label: string;
  form: ProviderForm;
  connected: boolean;
  /**
   * Saved but not yet connected: an ad platform waiting for somebody to sign
   * in. Its settings are kept on an edit and it can be turned off, exactly as
   * a connected one.
   */
  saved?: boolean;
  credentialRef: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, actionForm, pending] = useKeptAction<ActionState>(connect, {});
  const [offState, offActionForm, offPending] = useKeptAction<ActionState>(disconnect, {});

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="h-9 rounded border border-steel-300 px-3 text-sm font-medium"
          aria-expanded={open}
        >
          {open ? "Cancel" : saved ? "Change settings" : `Connect ${label}`}
        </button>
        {saved && (
          <form {...offActionForm}>
            <input type="hidden" name="provider" value={provider} />
            <button
              type="submit"
              disabled={offPending}
              className="h-9 rounded border border-steel-300 px-3 text-sm text-red-600"
            >
              {offPending ? "Turning off" : "Disconnect"}
            </button>
          </form>
        )}
      </div>
      {offState.error && <p className="mt-2 text-sm text-red-600" role="alert">{offState.error}</p>}

      {open && (
        <form {...actionForm} className="mt-3 grid max-w-xl gap-3">
          <input type="hidden" name="provider" value={provider} />
          <input type="hidden" name="existing" value={saved ? "1" : "0"} />
          {saved && (
            <p className="text-sm text-ink-500">
              Leave a box empty to keep what is stored. Nothing stored is shown back here.
            </p>
          )}
          <label className="grid gap-1">
            <span className="text-sm font-medium text-ink-700">Label (optional)</span>
            <input name="accountLabel" className={input} placeholder={label} />
          </label>
          {form.credential && (
            <label className="grid gap-1">
              <span className="text-sm font-medium text-ink-700">{form.credential}</span>
              <input
                name="credentialRef"
                className={input}
                placeholder={credentialRef ?? "STRIPE_SECRET_KEY"}
                autoComplete="off"
              />
              <span className="text-xs text-ink-500">
                The name your deployment keeps the secret under, not the secret. This product
                never stores the value.
              </span>
            </label>
          )}
          {form.fields.map((field) => (
            <label key={field.key} className="grid gap-1">
              <span className="text-sm font-medium text-ink-700">{field.label}</span>
              {field.kind === "select" || field.kind === "yesno" ? (
                <select name={`setting:${field.key}`} className={input} defaultValue="">
                  <option value="">{saved ? "Keep as it is" : field.kind === "yesno" ? "Yes" : "Choose"}</option>
                  {(field.kind === "yesno" ? ["yes", "no"] : field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  name={`setting:${field.key}`}
                  type={field.kind === "number" ? "number" : "text"}
                  className={input}
                  placeholder={field.placeholder}
                  autoComplete="off"
                />
              )}
              {field.kind === "secret_name" && (
                <span className="text-xs text-ink-500">
                  A name in your secret store, not the secret. A value pasted here is refused.
                </span>
              )}
              {field.hint && <span className="text-xs text-ink-500">{field.hint}</span>}
            </label>
          ))}
          <div>
            <button
              type="submit"
              disabled={pending}
              className="h-10 rounded bg-ink-900 px-4 text-sm font-medium text-white disabled:opacity-40"
            >
              {pending ? "Saving" : saved ? "Save" : form.signIn ? "Save settings" : "Connect"}
            </button>
          </div>
          {state.error && <p className="text-sm text-red-600" role="alert">{state.error}</p>}
          {state.done && <p className="text-sm text-ink-500" role="status">Saved.</p>}
        </form>
      )}
    </div>
  );
}
