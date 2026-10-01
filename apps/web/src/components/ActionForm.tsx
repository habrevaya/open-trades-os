"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/lib/actions";

/**
 * A form that posts to one server action and says what happened.
 *
 * The fields are passed in as children, so a server page can lay a form out
 * with the data it has already read and leave only the posting to the
 * client. A refusal is the service's own sentence, under the button, as an
 * alert so a screen reader announces it.
 */
export function ActionForm({
  action, submit, children, hidden = {}, className = "mt-4 space-y-4", tone = "primary", done,
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  /** The button's words. Say what happens: "Book job", not "Submit". */
  submit: string;
  children?: ReactNode;
  hidden?: Record<string, string>;
  className?: string;
  tone?: "primary" | "quiet" | "danger";
  /** Said after it worked, when the page does not visibly change. */
  done?: string;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className={className}>
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit" disabled={pending}
          className={
            tone === "quiet"
              ? "inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60"
              : tone === "danger"
                ? "inline-flex h-9 items-center rounded border border-red-600 px-3 text-sm font-medium text-red-600 hover:bg-red-tint disabled:opacity-60"
                : "inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60"
          }
        >
          {pending ? "Saving" : submit}
        </button>
        {state?.done && done ? <span role="status" className="text-sm text-ink-700">{done}</span> : null}
      </div>
      {state?.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}

/** A labelled input, the shape every office form here uses. */
export function TextField({
  label, name, className, ...rest
}: { label: string; name: string; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={className ?? "block"}>
      <span className="text-sm font-medium text-ink-700">{label}</span>
      <input name={name} {...rest}
             className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm" />
    </label>
  );
}

export function TextArea({
  label, name, rows = 3, ...rest
}: { label: string; name: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink-700">{label}</span>
      <textarea name={name} rows={rows} {...rest}
                className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 text-sm" />
    </label>
  );
}

export function Select({
  label, name, options, className, ...rest
}: {
  label: string; name: string; options: readonly { value: string; label: string }[]; className?: string;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className={className ?? "block"}>
      <span className="text-sm font-medium text-ink-700">{label}</span>
      <select name={name} {...rest}
              className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
