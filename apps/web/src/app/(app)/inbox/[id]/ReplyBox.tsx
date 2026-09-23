"use client";

import { useActionState, useRef, useEffect } from "react";
import { sendReply } from "./actions";

export function ReplyBox({ conversationId }: { conversationId: string }) {
  const [state, action, pending] = useActionState(sendReply, null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Cleared only on success. A refusal keeps what they wrote, because
    // losing a typed message to an error is how somebody stops using a box.
    if (state && "sent" in state) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={action} className="mt-8">
      <input type="hidden" name="conversationId" value={conversationId} />
      {state && "error" in state ? (
        <p role="alert" className="mb-3 rounded border border-red-600/20 bg-red-tint px-3 py-2 text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      <label className="block">
        <span className="sr-only">Reply</span>
        <textarea
          name="body" rows={3} required
          placeholder="Write a reply"
          className="w-full rounded border border-steel-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={pending}
                className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white transition-colors hover:bg-ink-700 disabled:opacity-60">
          {pending ? "Sending" : "Send"}
        </button>
        <span className="text-sm text-ink-500">
          Queued and handed to the carrier by the worker.
        </span>
      </div>
    </form>
  );
}
