"use client";

import { useActionState } from "react";
import { claimTask, closeTask } from "./actions";

/**
 * Claim, done, or decided against.
 *
 * Dismissing asks for a reason, because a dismissal with none is
 * indistinguishable from somebody deleting a task to make their queue look
 * shorter, and the service refuses it anyway.
 */
export function TaskActions({
  id, claimable, closable,
}: { id: string; claimable: boolean; closable: boolean }) {
  const [claimState, claim, claiming] = useActionState(claimTask, null);
  const [closeState, close, closing] = useActionState(closeTask, null);
  const error = (claimState && "error" in claimState && claimState.error)
    || (closeState && "error" in closeState && closeState.error);

  if (!claimable && !closable) return null;

  return (
    <div className="mt-3">
      {error ? (
        <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {claimable && (
          <form action={claim}>
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={claiming}
                    className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
              {claiming ? "Claiming" : "Claim"}
            </button>
          </form>
        )}

        {closable && (
          <form action={close} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={id} />
            <input
              name="outcome" placeholder="What happened"
              aria-label="What happened"
              className="h-8 w-56 rounded border border-steel-300 px-2 text-sm"
            />
            <button type="submit" disabled={closing}
                    className="inline-flex h-8 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
              Done
            </button>
            <button type="submit" name="dismissed" value="1" disabled={closing}
                    className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm text-ink-700 hover:bg-steel-100 disabled:opacity-60">
              Dismiss
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
