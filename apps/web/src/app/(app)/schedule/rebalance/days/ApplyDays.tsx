"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyDays } from "./actions";

/**
 * The one button on this screen that changes anything. Nothing moves until
 * it is pressed, and then every day moves at once or none does.
 */
export function ApplyDays({ payload, customersTold }: {
  payload: Parameters<typeof applyDays>[0];
  /** How many customers will be told their visit moved, said on the button's line. */
  customersTold: number;
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
          const result = await applyDays(payload);
          if (result.ok) {
            /** Said by the page, through the address, as the single day screen does. */
            router.replace(`/schedule/rebalance/days?from=${payload.from}&days=${payload.days}&moved=${result.movedDays}&told=${result.told}`);
            return;
          }
          setRefusal(result.message);
        })}
        className="h-9 rounded bg-ink-900 px-3 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Applying" : "Apply these changes"}
      </button>
      <a href={`/schedule?date=${payload.from}`} className="text-sm text-ink-700 underline">
        Leave the days as they are
      </a>
      {customersTold > 0 && (
        <p className="basis-full text-xs text-ink-500">
          {customersTold === 1 ? "The customer whose visit moves day is" : `The ${customersTold} customers whose visits move day are`} told
          by text, or by email when they cannot be texted, as when the office answers their own request to move.
        </p>
      )}
      {refusal && <p role="alert" className="basis-full text-sm text-red-600">{refusal}</p>}
    </div>
  );
}
