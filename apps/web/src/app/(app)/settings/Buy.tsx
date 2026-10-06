"use client";

import { useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { Phone } from "@opentradesos/ui";
import { searchNumbers, buyNumber } from "./actions";
import type { CreditOption } from "./Numbers";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";
const FIELD = "h-8 rounded border border-steel-300 px-2 text-sm";

type Found = { e164: string; friendlyName: string; locality: string | null; region: string | null };
type SearchState = { done?: boolean; error?: string; numbers?: Found[] } | null;
type BuyState = { done?: boolean; error?: string; bought?: string } | null;

/**
 * BUY A NUMBER FROM YOUR OWN TWILIO ACCOUNT
 *
 * Two steps on one screen: ask the carrier what it has near an area code or
 * a town, then pick one and say what it is for. The purchase points the
 * number's calls at this installation as it happens, so there is nothing to
 * paste into Twilio afterwards.
 *
 * A tracking number is credited to a campaign or a channel. A website pool
 * number is credited to whichever visit it was shown on, so it takes no
 * campaign and the box disappears.
 */
export function Buy({ credits }: { credits: CreditOption[] }) {
  const [found, searchForm, searching] = useKeptAction<SearchState>(searchNumbers, null);
  const [bought, buyForm, buying] = useKeptAction<BuyState>(buyNumber, null);
  const [purpose, setPurpose] = useState("tracking");
  const [hours, setHours] = useState(false);
  const numbers = found?.numbers ?? [];

  return (
    <div className="mt-4 rounded-md border border-steel-200 p-3">
      <h3 className="text-sm font-medium text-ink-900">Buy a number from your Twilio account</h3>
      <form {...searchForm} className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-500">Area code
          <input name="areaCode" inputMode="numeric" maxLength={3} placeholder="512" className={`mt-1 block w-20 ${FIELD}`} />
        </label>
        <label className="text-xs text-ink-500">Or a town
          <input name="locality" placeholder="Austin" className={`mt-1 block ${FIELD}`} />
        </label>
        <label className="text-xs text-ink-500">State
          <input name="region" maxLength={2} placeholder="TX" className={`mt-1 block w-16 ${FIELD}`} />
        </label>
        <button type="submit" disabled={searching} className={BUTTON}>{searching ? "Searching" : "Find numbers"}</button>
      </form>
      {found?.error ? <p role="alert" className="mt-2 text-sm text-red-600">{found.error}</p> : null}
      {found?.done && numbers.length === 0 ? (
        <p className="mt-2 text-sm text-ink-700">Twilio has nothing free there. Try a neighbouring area code.</p>
      ) : null}

      {numbers.length > 0 && (
        <form {...buyForm} className="mt-3 space-y-3">
          <fieldset>
            <legend className="text-xs text-ink-500">Pick one</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {numbers.map((n, i) => (
                <label key={n.e164} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="e164" value={n.e164} defaultChecked={i === 0} />
                  <Phone value={n.e164} />
                  <span className="text-ink-500">{[n.locality, n.region].filter(Boolean).join(", ")}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-ink-500">What it is for
              <select name="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} className={`mt-1 block ${FIELD}`}>
                <option value="tracking">Tracking a campaign</option>
                <option value="pool">Website pool (swapped onto your site)</option>
              </select>
            </label>
            {purpose === "tracking" && (
              <label className="text-xs text-ink-500">Calls to it are credited to
                <select name="credit" required className={`mt-1 block ${FIELD}`}>
                  {credits.map((channel) => (
                    <optgroup key={channel.id} label={channel.name}>
                      {channel.campaigns.map((c) => (
                        <option key={c.id} value={`campaign:${c.id}`}>{channel.name}: {c.name}</option>
                      ))}
                      <option value={`channel:${channel.id}`}>{channel.name}, no campaign</option>
                    </optgroup>
                  ))}
                </select>
              </label>
            )}
            <label className="text-xs text-ink-500">Label
              <input name="label" placeholder="Spring mailer" className={`mt-1 block ${FIELD}`} />
            </label>
            <label className="text-xs text-ink-500">Ring this number
              <input name="forwardsToE164" placeholder="+15125550100" className={`mt-1 block ${FIELD}`} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="whisper" value="yes" defaultChecked />
              Tell whoever answers where the call came from
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="recordCalls" value="yes" />
              Ask callers if the call may be recorded
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="routeByHours" value="yes" checked={hours} onChange={(e) => setHours(e.target.checked)} />
              Different outside business hours
            </label>
            {hours && (
              <label className="text-xs text-ink-500">After hours, ring (blank for voicemail)
                <input name="afterHoursForwardsToE164" placeholder="+15125550199" className={`mt-1 block ${FIELD}`} />
              </label>
            )}
          </div>
          <button type="submit" disabled={buying} className={BUTTON}>{buying ? "Buying" : "Buy this number"}</button>
          {bought?.error ? <p role="alert" className="text-sm text-red-600">{bought.error}</p> : null}
          {bought?.bought ? <p role="status" className="text-sm text-ink-700">Bought {bought.bought}. Its calls now ring here first.</p> : null}
        </form>
      )}
      <p className="mt-2 text-xs text-ink-500">
        Recording is only ever switched on for a caller who presses 1 after being asked, and only when
        your recording declarations above allow it.
      </p>
    </div>
  );
}
