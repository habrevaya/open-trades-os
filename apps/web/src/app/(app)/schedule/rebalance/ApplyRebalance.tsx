"use client";

import { useState, useTransition } from "react";
import { applyRebalance } from "./actions";

/**
 * The one button that changes anything on this screen. Nothing moves until
 * it is pressed, and then everything moves at once or nothing does.
 */
export function ApplyRebalance({ payload }: {
  payload: Parameters<typeof applyRebalance>[0];
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending || message?.ok === true}
        onClick={() => start(async () => {
          const result = await applyRebalance(payload);
          setMessage(result.ok
            ? { ok: true, text: `Done. ${result.moved} ${result.moved === 1 ? "visit has" : "visits have"} a new technician, and each changed day is in its new order.` }
            : { ok: false, text: result.message });
        })}
        className="h-9 rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Applying" : "Apply these changes"}
      </button>
      <a href={`/schedule?date=${payload.date}`} className="text-sm text-ink-700 underline">
        {message?.ok ? "Back to the board" : "Leave the day as it is"}
      </a>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={`basis-full text-sm ${message.ok ? "text-green-700" : "text-red-600"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
