"use client";

import { useActionState, type ReactNode } from "react";

export type OpState = { done?: boolean; error?: string } | null;

/**
 * A form that runs one named operation through a server action and says
 * what happened.
 *
 * The screens built over the API-only modules (projects, certifications,
 * the fleet) each have one action that switches on `op`, so each of their
 * small forms is this plus its fields. A refusal is the service's own
 * sentence, shown under the form, and what was typed stays.
 */
export function OpForm({
  action, op, label, children, className = "flex flex-wrap items-end gap-2", quiet = false, hidden = {},
}: {
  action: (previous: OpState, form: FormData) => Promise<OpState>;
  op: string;
  label: string;
  children?: ReactNode;
  className?: string;
  quiet?: boolean;
  hidden?: Record<string, string>;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className={className}>
      <input type="hidden" name="op" value={op} />
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {children}
      <button
        type="submit" disabled={pending}
        className={quiet
          ? "inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100 disabled:opacity-60"
          : "inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-60"}
      >
        {pending ? "Saving" : label}
      </button>
      {state?.error && <p role="alert" className="basis-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
