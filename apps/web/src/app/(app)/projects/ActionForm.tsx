"use client";

import { useActionState, type ReactNode } from "react";
import { act } from "./actions";

/**
 * A form that runs one project operation and says what happened.
 *
 * A refusal keeps what was typed, because losing a schedule of values to a
 * validation message is how somebody stops using the screen.
 */
export function ActionForm({
  op, projectId, label, children, className = "flex flex-wrap items-end gap-2", tone = "primary",
}: {
  op: string;
  projectId?: string;
  label: string;
  children?: ReactNode;
  className?: string;
  tone?: "primary" | "quiet";
}) {
  const [state, action, pending] = useActionState(act, null);
  return (
    <form action={action} className={className}>
      <input type="hidden" name="op" value={op} />
      {projectId && <input type="hidden" name="projectId" value={projectId} />}
      {children}
      <button
        type="submit" disabled={pending}
        className={tone === "primary"
          ? "inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-60"
          : "inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100 disabled:opacity-60"}
      >
        {pending ? "Saving" : label}
      </button>
      {state?.error && <p role="alert" className="basis-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
