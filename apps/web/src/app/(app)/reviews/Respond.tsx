"use client";

import { useActionState } from "react";
import { respondToReview, markCalled } from "./actions";

/**
 * A reply, and separately a phone call.
 *
 * Two buttons because they are two acts: one is what the next prospect
 * reads, the other is a conversation. A single "handled" control would let a
 * good public reply close out a call that never happened.
 */
export function Respond({ id, callOwed }: { id: string; callOwed: boolean }) {
  const [replyState, reply, replying] = useActionState(respondToReview, null);
  const [callState, call, calling] = useActionState(markCalled, null);
  const error = (replyState && "error" in replyState && replyState.error)
    || (callState && "error" in callState && callState.error);

  return (
    <div className="mt-3">
      {error ? <p role="alert" className="mb-2 text-sm text-red-600">{error}</p> : null}

      <form action={reply} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={id} />
        <textarea
          name="body"
          rows={2}
          placeholder="Answer what they actually said"
          className="min-w-64 flex-1 rounded border border-steel-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={replying}
          className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60"
        >
          {replying ? "Posting" : "Post reply"}
        </button>
      </form>

      {callOwed && (
        <form action={call} className="mt-2">
          <input type="hidden" name="id" value={id} />
          <button
            type="submit"
            disabled={calling}
            className="inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60"
          >
            {calling ? "Saving" : "I rang them"}
          </button>
        </form>
      )}
    </div>
  );
}
