"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyRebalance } from "./actions";

/**
 * The one button that changes anything on this screen. Nothing moves until
 * it is pressed, and then everything moves at once or nothing does.
 */
export function ApplyRebalance({ payload }: {
  payload: Parameters<typeof applyRebalance>[0];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          const result = await applyRebalance(payload);
          if (result.ok) {
            /**
             * Said by the page, through the address, not by this button: the
             * apply refreshes the schedule, the fresh proposal has nothing left
             * to move, and this button is gone with any message it held.
             */
            router.replace(`/schedule/rebalance?date=${payload.date}&applied=${result.moved}`);
            return;
          }
          setRefusal(result.message);
        })}
        className="h-9 rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Applying" : "Apply these changes"}
      </button>
      <a href={`/schedule?date=${payload.date}`} className="text-sm text-ink-700 underline">
        Leave the day as it is
      </a>
      {refusal && <p role="alert" className="basis-full text-sm text-red-600">{refusal}</p>}
    </div>
  );
}
