"use client";

import { useActionState } from "react";
import { Chip } from "@opentradesos/ui";
import { grantMarketing, revokeMarketing } from "./actions";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";

/**
 * WHETHER YOU MAY TEXT THIS PERSON ABOUT OFFERS
 *
 * Separate from whether you may text them at all, which is the distinction
 * the whole consent model turns on and the one a single "can we contact
 * them" toggle destroys. Work in flight implies its own messages: the
 * technician is on the way, here is your invoice. Marketing implies nothing
 * and needs a granted record, with the wording that was used.
 *
 * So this section is only ever about marketing, and says so, because a
 * screen that read "no consent" next to a customer the company texts every
 * week would teach people to ignore it.
 *
 * A SUPPRESSION IS NOT SHOWN AS A MISSING CONSENT. Somebody who replied STOP
 * is not somebody who has not got round to opting in, and offering a grant
 * button under that state invites a company to overwrite a carrier level opt
 * out with a form submission.
 */
export function Consent({
  address, allowed, reason, hasRecord,
}: {
  address: string;
  allowed: boolean;
  reason: string;
  hasRecord: boolean;
}) {
  const [grantState, grant, granting] = useActionState(grantMarketing, null);
  const [revokeState, revoke, revoking] = useActionState(revokeMarketing, null);
  const error = (grantState && "error" in grantState && grantState.error)
    || (revokeState && "error" in revokeState && revokeState.error);

  const suppressed = reason === "suppressed";

  return (
    <div className="mt-10">
      <h2 className="text-base font-semibold">Marketing messages</h2>
      <p className="mt-1 max-w-prose text-xs text-ink-500">
        Only about offers. Messages about work already booked go out either
        way, unless they reply STOP.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {allowed
          ? <Chip tone="success">Consented</Chip>
          : suppressed
            ? <Chip tone="danger">Replied STOP</Chip>
            : reason === "consent_revoked"
              ? <Chip tone="warning">Withdrawn</Chip>
              : reason === "channel_not_registered"
                ? <Chip tone="neutral">No registered number to send from</Chip>
                : <Chip tone="neutral">No consent on record</Chip>}
        <span className="text-sm text-ink-700">{address}</span>
      </div>

      {suppressed ? (
        /*
          No button. They told the carrier to stop, and the way back is them
          texting START, not the office ticking a box on their behalf.
        */
        <p className="mt-3 max-w-prose text-sm text-ink-700">
          They replied STOP to a text. Only they can undo that, by texting
          START. Recording a consent here would not change it and should not.
        </p>
      ) : allowed || hasRecord ? (
        <form action={revoke} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="address" value={address} />
          <label className="sr-only" htmlFor="revoke-reason">What they said</label>
          <input
            id="revoke-reason" name="proofText"
            placeholder="What they said, if they said it on a call"
            className="h-8 min-w-64 rounded border border-steel-300 px-2 text-sm"
          />
          <button type="submit" disabled={revoking} className={BUTTON}>
            {revoking ? "Recording" : "They asked us to stop"}
          </button>
        </form>
      ) : null}

      {!suppressed && !allowed && (
        <form action={grant} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="address" value={address} />
          <div>
            <label htmlFor="proof" className="block text-xs text-ink-500">
              {/*
                Required, and the label says why. A consent row with no
                wording on it is a row that loses an argument.
              */}
              The wording they agreed to
            </label>
            <input
              id="proof" name="proofText" required
              placeholder="Yes, text me about seasonal offers"
              className="mt-1 h-8 min-w-72 rounded border border-steel-300 px-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="method" className="block text-xs text-ink-500">How</label>
            <select id="method" name="method"
                    className="mt-1 h-8 rounded border border-steel-300 px-2 text-sm">
              <option value="verbal">On a call</option>
              <option value="web_form">A form they filled in</option>
              <option value="written">In writing</option>
              <option value="checkout">At checkout</option>
            </select>
          </div>
          <button type="submit" disabled={granting} className={BUTTON}>
            {granting ? "Recording" : "Record consent"}
          </button>
        </form>
      )}

      {error ? <p role="alert" className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
