"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { answerVisitChangeProposal, type VisitChangeResult } from "./visit-change-actions";

/** What a signed in page hands in instead of a token: an action bound on the server. */
export type SendProposalAnswer = (input: {
  visitId?: string | undefined;
  accept: boolean;
  answer?: string | undefined;
}) => Promise<VisitChangeResult>;

/**
 * YES OR NO TO THE TIME THE OFFICE OFFERED.
 *
 * Two buttons and a box for anything they want to say. Yes moves the visit
 * there and then; no leaves it where it is, and the office is asked to get
 * in touch. Both are said before they are pressed.
 */
export function ProposalAnswer({
  token, send, visitId, offered, path,
}: {
  token?: string;
  send?: SendProposalAnswer;
  visitId?: string;
  /** The time offered, in words. */
  offered: string;
  path: string;
}) {
  const router = useRouter();
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const reply = async (accept: boolean) => {
    setBusy(true);
    setRefusal(null);
    const input = { ...(visitId ? { visitId } : {}), accept, ...(words.trim() ? { answer: words.trim() } : {}) };
    const result = send
      ? await send(input)
      : await answerVisitChangeProposal({ token: token ?? "", ...input, path });
    setBusy(false);
    if (!result.ok) {
      setRefusal(result.message);
      return;
    }
    router.refresh();
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="font-medium text-ink-700">Anything to add (optional)</span>
        <textarea
          value={words}
          onChange={(e) => setWords(e.target.value)}
          maxLength={1000}
          rows={2}
          className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => reply(true)}
          className="h-10 rounded bg-ink-900 px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          Yes, move it to {offered}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => reply(false)}
          className="h-10 rounded border border-steel-300 px-4 text-sm font-medium disabled:opacity-60"
        >
          No, that does not work
        </button>
      </div>
      <p className="text-xs text-ink-500">
        Yes moves your visit to that time. No keeps it where it is, and the office will be in touch.
      </p>
      {refusal && <p role="alert" className="text-sm text-red-600">{refusal}</p>}
    </div>
  );
}
