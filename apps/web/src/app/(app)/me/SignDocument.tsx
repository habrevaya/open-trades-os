"use client";

import { useState, useTransition } from "react";
import { ActionForm, TextField } from "@/components/ActionForm";
import { SignaturePad } from "../my-day/SignaturePad";
import { signDrawn, signTyped } from "./actions";

/**
 * ONE DOCUMENT WAITING FOR A SIGNATURE
 *
 * The words first, in full and scrollable, because a signature is a statement
 * about what was read. Then the two ways to sign, chosen rather than both
 * shown at once: typing their name, or drawing it with a finger on a phone.
 * Either way the server keeps the same record, and says which way it was.
 */
export function SignDocument({ requestId, title, body }: { requestId: string; title: string; body: string }) {
  const [how, setHow] = useState<"typed" | "drawn">("typed");
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <article aria-label={title} className="rounded border border-steel-200 bg-canvas p-3">
      <h3 className="font-medium">{title}</h3>
      <div
        tabIndex={0}
        aria-label={`The words of ${title}`}
        className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-steel-200 bg-steel-100 p-3 text-sm text-ink-700"
      >
        {body}
      </div>
      {said?.ok ? (
        <p role="status" className="mt-3 text-sm text-green-700">{said.message}</p>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-ink-700">Signing says you have read these words and agree to them.</p>
          <div className="mt-2 flex gap-2" role="group" aria-label="How to sign">
            <button type="button" aria-pressed={how === "typed"} onClick={() => setHow("typed")}
                    className={`h-9 rounded border px-3 text-sm ${how === "typed" ? "border-ink-900 font-medium" : "border-steel-300"}`}>
              Type my name
            </button>
            <button type="button" aria-pressed={how === "drawn"} onClick={() => setHow("drawn")}
                    className={`h-9 rounded border px-3 text-sm ${how === "drawn" ? "border-ink-900 font-medium" : "border-steel-300"}`}>
              Draw my signature
            </button>
          </div>
          {how === "typed" ? (
            <ActionForm action={signTyped} submit={`Sign ${title}`} hidden={{ requestId }} className="mt-3 space-y-3">
              <TextField label="Your full name" name="typedName" required autoComplete="name" maxLength={200} />
            </ActionForm>
          ) : (
            <div className="mt-3">
              <SignaturePad
                label={`Draw your signature for ${title}`}
                pending={pending}
                onSign={(png) => start(async () => setSaid(await signDrawn({ requestId, drawing: png })))}
              />
              {said && !said.ok ? <p role="alert" className="mt-2 text-sm text-red-600">{said.message}</p> : null}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
