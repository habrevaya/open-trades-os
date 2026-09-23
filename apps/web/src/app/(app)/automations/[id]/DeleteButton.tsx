"use client";

import { useActionState } from "react";
import { deleteAutomation } from "../actions";

/**
 * Deleting an automation keeps its runs.
 *
 * The workflow is soft deleted, so "why did this customer get that text in
 * March" still has an answer after somebody tidied up in April.
 */
export function DeleteButton({ id, name }: { id: string; name: string }) {
  const [state, submit, pending] = useActionState(deleteAutomation, null);

  return (
    <form
      action={submit}
      onSubmit={(event) => {
        if (!confirm(`Delete "${name}"? Its run history stays.`)) event.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit" disabled={pending}
        className="text-sm text-ink-500 hover:text-red-600 hover:underline disabled:opacity-60"
      >
        {pending ? "Deleting" : "Delete this automation"}
      </button>
      {state && "error" in state && state.error ? (
        <span role="alert" className="ml-2 text-sm text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
