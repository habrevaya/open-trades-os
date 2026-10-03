"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { sendReply } from "./actions";

export function ReplyBox({ conversationId, byEmail = false }: { conversationId: string; byEmail?: boolean }) {
  const [state, actionForm, pending] = useKeptAction(sendReply, null);
  /*
    Cleared on success by React's own reset after the action. A refusal
    keeps what they wrote, because losing a typed message to an error is how
    somebody stops using a box: the action hands it back and useKeptAction
    puts it back.
  */

  return (
    <form {...actionForm} className="mt-8">
      <input type="hidden" name="conversationId" value={conversationId} />
      {state && "error" in state ? (
        <p role="alert" className="mb-3 rounded border border-red-600/20 bg-red-tint px-3 py-2 text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      <label className="block">
        <span className="sr-only">Reply</span>
        <textarea
          name="body" rows={3} required={byEmail}
          placeholder={byEmail ? "Write a reply by email" : "Write a reply"}
          className="w-full rounded border border-steel-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="mt-2 block text-sm">
        <span className="text-ink-700">{byEmail ? "Attach pictures" : "Send pictures"}</span>
        <input type="file" name="pictures" accept="image/jpeg,image/png,image/gif" multiple
               className="mt-1 block text-sm" />
        <span className="mt-1 block text-xs text-ink-500">
          Up to three JPEG, PNG or GIF pictures, five megabytes together.
        </span>
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={pending}
                className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white transition-colors hover:bg-ink-700 disabled:opacity-60">
          {pending ? "Sending" : "Send"}
        </button>
        <span className="text-sm text-ink-500">
          {byEmail
            ? "Queued and handed to your email provider by the worker."
            : "Queued and handed to the carrier by the worker."}
        </span>
      </div>
    </form>
  );
}
