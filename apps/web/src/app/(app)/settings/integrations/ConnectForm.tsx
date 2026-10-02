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
  provider, label, form, connected, credentialRef, environmentPrefix,
}: {
  provider: string;
  label: string;
  form: ProviderForm;
  connected: boolean;
  credentialRef: string | null;
  /** `OTS_SECRET__<company>__` when the deployment keeps secrets in its environment, else null. */
  environmentPrefix: string | null;
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
          {open ? "Cancel" : connected ? "Change settings" : `Connect ${label}`}
        </button>
        {connected && (
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
          <input type="hidden" name="existing" value={connected ? "1" : "0"} />
          {connected && (
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
                {environmentPrefix && (
                  <>
                    {" "}The server reads it from the environment variable{" "}
                    <code className="break-all font-mono">{environmentPrefix}</code> followed by this
                    name, for example{" "}
                    <code className="break-all font-mono">{environmentPrefix}STRIPE_SECRET_KEY</code>.
                  </>
                )}
              </span>
            </label>
          )}
          {form.fields.map((field) => (
            <label key={field.key} className="grid gap-1">
              <span className="text-sm font-medium text-ink-700">{field.label}</span>
              {field.kind === "select" ? (
                <select name={`setting:${field.key}`} className={input} defaultValue="">
                  <option value="">{connected ? "Keep as it is" : "Choose"}</option>
                  {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
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
                  {environmentPrefix && (
                    <> Read from <code className="break-all font-mono">{environmentPrefix}</code> followed by the name.</>
                  )}
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
              {pending ? "Saving" : connected ? "Save" : "Connect"}
            </button>
          </div>
          {state.error && <p className="text-sm text-red-600" role="alert">{state.error}</p>}
          {state.done && <p className="text-sm text-ink-500" role="status">Saved.</p>}
        </form>
      )}
    </div>
  );
}
