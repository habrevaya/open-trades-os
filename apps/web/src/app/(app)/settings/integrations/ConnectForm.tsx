"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useState } from "react";
import { clearSecret, connect, disconnect, saveSecret, type ActionState } from "./actions";
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
  provider, label, form, connected, credentialRef, environmentPrefix, store = "environment",
}: {
  provider: string;
  label: string;
  form: ProviderForm;
  connected: boolean;
  credentialRef: string | null;
  /** `OTS_SECRET__<company>__` when the deployment keeps secrets in its environment, else null. */
  environmentPrefix: string | null;
  /**
   * `database`: secrets are pasted here, once, into password boxes that are
   * never filled back in. `environment`: names are typed and the operator
   * sets the variables.
   */
  store?: "environment" | "database";
}) {
  const pastes = store === "database";
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
          {form.credential && pastes && (
            <label className="grid gap-1">
              <span className="text-sm font-medium text-ink-700">{form.credentialSecret ?? form.credential}</span>
              <input
                name="secretValue:credential"
                type="password"
                className={input}
                placeholder={connected ? "Leave empty to keep the one that is set" : "Paste it here"}
                autoComplete="new-password"
              />
              <span className="text-xs text-ink-500">
                Encrypted and stored for this company only. It is never shown again, here or anywhere:
                you can replace it or clear it.
              </span>
            </label>
          )}
          {form.credential && !pastes && (
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
              <span className="text-sm font-medium text-ink-700">
                {field.kind === "secret_name" && pastes ? (field.secretLabel ?? field.label) : field.label}
              </span>
              {field.kind === "secret_name" && pastes ? (
                <input
                  name={`secretValue:${field.key}`}
                  type="password"
                  className={input}
                  placeholder={connected ? "Leave empty to keep the one that is set" : "Paste it here"}
                  autoComplete="new-password"
                />
              ) : field.kind === "select" ? (
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
              {field.kind === "secret_name" && !pastes && (
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

/**
 * One stored secret, with the database store: set or not, its last four, and
 * a box to replace it and a button to clear it. Write only: there is nothing
 * to reveal, because nothing here can read the value back.
 */
export function SecretRow({
  name, set, last4,
}: {
  name: string;
  set: boolean;
  last4: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, saveForm, saving] = useKeptAction<ActionState>(saveSecret, {});
  const [clearState, clearForm, clearing] = useKeptAction<ActionState>(clearSecret, {});
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="h-8 rounded border border-steel-300 px-3 text-xs font-medium"
          aria-expanded={open}
        >
          {open ? "Cancel" : set ? `Replace ${name}` : `Set ${name}`}
        </button>
        {set && (
          <form {...clearForm}>
            <input type="hidden" name="name" value={name} />
            <button type="submit" disabled={clearing} className="h-8 rounded border border-steel-300 px-3 text-xs text-red-600">
              {clearing ? "Clearing" : `Clear ${name}`}
            </button>
          </form>
        )}
      </div>
      {open && (
        <form {...saveForm} className="flex max-w-xl flex-wrap gap-2">
          <input type="hidden" name="name" value={name} />
          <input
            name="secretValue"
            type="password"
            aria-label={`New value for ${name}`}
            className="h-9 min-w-0 flex-1 rounded border border-steel-300 px-3 text-sm"
            placeholder={set && last4 ? `Replaces the one ending ${last4}` : "Paste it here"}
            autoComplete="new-password"
          />
          <button type="submit" disabled={saving} className="h-9 rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-40">
            {saving ? "Saving" : "Save"}
          </button>
        </form>
      )}
      {state.error && <p className="text-sm text-red-600" role="alert">{state.error}</p>}
      {state.done && <p className="text-sm text-ink-500" role="status">Saved. It will not be shown again.</p>}
      {clearState.error && <p className="text-sm text-red-600" role="alert">{clearState.error}</p>}
    </div>
  );
}
