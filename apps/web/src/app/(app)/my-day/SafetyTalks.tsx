"use client";

import { useState, useTransition } from "react";
import { SignaturePad } from "./SignaturePad";
import { signTalk } from "./safety-actions";

export interface TalkToSign {
  meetingId: string;
  topic: string;
  notes: string | null;
  heldAt: string;
  location: string | null;
  ledBy: string | null;
  signedAt: string | null;
  cannotSign: string | null;
}

/**
 * THE TOOLBOX TALKS ON A TECHNICIAN'S DAY
 *
 * The ones waiting for their signature, each with what was covered so they
 * can read it before signing, and a pad to sign on. Their own lines only:
 * who else was there is the register, and the register is not theirs.
 */
export function SafetyTalks({ talks, timezone }: { talks: TalkToSign[]; timezone: string }) {
  const waiting = talks.filter((talk) => !talk.signedAt);
  if (waiting.length === 0) return null;
  return (
    <section className="mx-4 mt-4 rounded-md border border-amber-700 bg-amber-tint p-4" aria-labelledby="talks-heading">
      <h2 id="talks-heading" className="text-base font-semibold">
        {waiting.length === 1 ? "A toolbox talk to sign" : `${waiting.length} toolbox talks to sign`}
      </h2>
      <ul className="mt-3 space-y-4">
        {waiting.map((talk) => <Talk key={talk.meetingId} talk={talk} timezone={timezone} />)}
      </ul>
    </section>
  );
}

function Talk({ talk, timezone }: { talk: TalkToSign; timezone: string }) {
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);
  const when = new Date(talk.heldAt).toLocaleString("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  return (
    <li className="rounded border border-steel-200 bg-canvas p-3">
      <p className="font-medium">{talk.topic}</p>
      <p className="text-sm text-ink-500">
        {when}{talk.location ? `, ${talk.location}` : ""}{talk.ledBy ? `, led by ${talk.ledBy}` : ""}
      </p>
      {talk.notes ? <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{talk.notes}</p> : null}
      {said?.ok ? (
        <p role="status" className="mt-2 text-sm text-green-700">{said.message}</p>
      ) : talk.cannotSign ? (
        <p className="mt-2 text-sm text-ink-700">{talk.cannotSign}</p>
      ) : (
        <div className="mt-2">
          <p className="mb-1 text-sm text-ink-700">Signing says you were there and heard it.</p>
          <SignaturePad
            label={`Sign for ${talk.topic}`}
            pending={pending}
            onSign={(png) => start(async () => setSaid(await signTalk({ meetingId: talk.meetingId, signature: png })))}
          />
          {said && !said.ok ? <p role="alert" className="mt-2 text-sm text-red-600">{said.message}</p> : null}
        </div>
      )}
    </li>
  );
}
