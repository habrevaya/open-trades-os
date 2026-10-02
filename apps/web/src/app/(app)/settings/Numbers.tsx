"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useState } from "react";
import { Chip, Phone } from "@opentradesos/ui";
import { addNumber, releaseNumber, assignNumber } from "./actions";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";
const FIELD = "h-8 rounded border border-steel-300 px-2 text-sm";

export interface NumberRow {
  id: string;
  e164: string;
  label: string | null;
  purpose: string;
  attributionSource: string | null;
  channelId: string | null;
  campaignId: string | null;
  smsRegistered: boolean;
  isSender: boolean;
  /** Inbound calls in the last ninety days, on a tracking number. */
  calls90: number | null;
}

/** The company's channels and their tracking campaigns, for "calls to it are credited to". */
export interface CreditOption {
  id: string;
  name: string;
  campaigns: { id: string; name: string }[];
}

/**
 * The campaigns grouped under their channels, each channel also choosable on
 * its own for a number that belongs to a channel and no campaign in
 * particular. The value says which (`campaign:` or `channel:`).
 */
function CreditChoices({ options }: { options: CreditOption[] }) {
  return (
    <>
      {options.map((channel) => (
        <optgroup key={channel.id} label={channel.name}>
          {channel.campaigns.map((campaign) => (
            <option key={campaign.id} value={`campaign:${campaign.id}`}>{channel.name}: {campaign.name}</option>
          ))}
          <option value={`channel:${channel.id}`}>{channel.name}, no campaign</option>
        </optgroup>
      ))}
    </>
  );
}

/**
 * THE NUMBERS A COMPANY CONTROLS
 *
 * Two things on this screen are consequences rather than settings, and both
 * are marked on the row because nobody derives them from three columns.
 *
 * WHICH ONE TEXTS COME FROM. It follows from purpose, registration and age,
 * and it decides what a customer sees and replies to. A tracking number is
 * never it, whatever else is true, because a text from one corrupts the
 * measurement it exists for.
 *
 * WHAT A TRACKING NUMBER ATTRIBUTES TO. A tracking number with no source
 * measures nothing: every call to it reports as unknown, and the report says
 * the campaign produced nothing rather than that nobody finished setting it
 * up. The service refuses that state, so it cannot be reached from here.
 */
export function Numbers({
  numbers, credits,
}: {
  numbers: NumberRow[];
  credits: CreditOption[];
}) {
  const [addState, addForm, adding] = useKeptAction(addNumber, null);
  const [releaseState, releaseForm, releasing] = useKeptAction(releaseNumber, null);
  const [assignState, assignForm, assigning] = useKeptAction(assignNumber, null);
  const nameOf = (number: NumberRow) => {
    for (const channel of credits) {
      const campaign = channel.campaigns.find((c) => c.id === number.campaignId);
      if (campaign) return `${channel.name}: ${campaign.name}`;
      if (channel.id === number.channelId) return channel.name;
    }
    return number.attributionSource?.replace(/_/g, " ") ?? null;
  };
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState("main");

  const error = [addState, releaseState, assignState]
    .map((state) => (state && "error" in state ? state.error : null))
    .find(Boolean);
  const lost = releaseState && "nowSendingFrom" in releaseState
    ? releaseState.nowSendingFrom : undefined;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-ink-700">
          {numbers.length === 0
            ? "No numbers on file, so nothing can be sent."
            : `${numbers.length} on file.`}
        </span>
        <button type="button" onClick={() => setOpen((was) => !was)} className={BUTTON}>
          {open ? "Cancel" : "Add a number"}
        </button>
      </div>

      {numbers.length > 0 && (
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {numbers.map((number) => (
            <li key={number.id} className="flex flex-wrap items-baseline gap-2 bg-canvas p-3">
              <span className="font-medium"><Phone value={number.e164} /></span>
              {number.label && <span className="text-sm text-ink-500">{number.label}</span>}
              <Chip tone="neutral">{number.purpose}</Chip>
              {number.purpose === "tracking" && nameOf(number) && (
                <Chip tone="info">credited to {nameOf(number)}</Chip>
              )}
              {/*
                A tracking number nobody has rung in a quarter is still being
                paid for. Said on the row, where somebody decides whether to keep
                it, rather than on a report they would have to go and find.
              */}
              {number.calls90 !== null && (
                <Chip tone={number.calls90 === 0 ? "warning" : "neutral"}>
                  {number.calls90 === 1 ? "1 call" : `${number.calls90} calls`} in 90 days
                </Chip>
              )}
              {number.purpose === "tracking" && (
                <form {...assignForm} className="flex items-center gap-1">
                  <input type="hidden" name="id" value={number.id} />
                  <select name="credit" aria-label={`Campaign for ${number.e164}`}
                          defaultValue={number.campaignId ? `campaign:${number.campaignId}` : number.channelId ? `channel:${number.channelId}` : ""}
                          className={FIELD}>
                    <option value="" disabled>Choose a campaign</option>
                    <CreditChoices options={credits} />
                  </select>
                  <button type="submit" disabled={assigning} className={BUTTON}>
                    {assigning ? "Saving" : "Save"}
                  </button>
                </form>
              )}
              <Chip tone={number.smsRegistered ? "success" : "warning"}>
                {number.smsRegistered ? "Registered" : "Not registered"}
              </Chip>
              {number.isSender && <Chip tone="success">Texts come from here</Chip>}

              <form {...releaseForm} className="ml-auto">
                <input type="hidden" name="id" value={number.id} />
                <button type="submit" disabled={releasing} className={BUTTON}>
                  {releasing ? "Releasing" : "Hand it back"}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {/*
        Said after the fact because it is a consequence of the click, not a
        confirmation before it. Releasing the last number you can send from
        is allowed: a company leaving a provider releases everything, and
        refusing the last one makes them edit the database. What it must not
        be is silent.
      */}
      {lost === null && (
        <p className="mt-3 rounded-md border border-amber-700/20 bg-amber-tint p-3 text-sm text-ink-900">
          Nothing left to send from. Every text is refused until a registered
          number is added.
        </p>
      )}

      {open && (
        <form {...addForm} className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-steel-200 p-3">
          <div>
            <label htmlFor="n-e164" className="block text-xs text-ink-500">Number</label>
            <input id="n-e164" name="e164" required placeholder="+15125550123"
                   className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label htmlFor="n-label" className="block text-xs text-ink-500">Label</label>
            <input id="n-label" name="label" placeholder="Spring mailer"
                   className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label htmlFor="n-purpose" className="block text-xs text-ink-500">What it is for</label>
            <select id="n-purpose" name="purpose" value={purpose}
                    onChange={(event) => setPurpose(event.target.value)}
                    className={`mt-1 ${FIELD}`}>
              <option value="main">The main number</option>
              <option value="tracking">Tracking a campaign</option>
              <option value="sending">Outbound sending</option>
              <option value="user">One person&rsquo;s line</option>
              <option value="fax">Fax</option>
            </select>
          </div>
          {/*
            Only for a tracking number, and required there. The service
            refuses both the other combinations, and a field that appears
            and disappears says which one applies better than an error does.
          */}
          {purpose === "tracking" && (
            <div>
              <label htmlFor="n-source" className="block text-xs text-ink-500">
                Calls to it are credited to
              </label>
              <select id="n-source" name="credit" required className={`mt-1 ${FIELD}`}>
                <CreditChoices options={credits} />
              </select>
            </div>
          )}
          <label className="flex h-8 items-center gap-2 text-sm">
            <input type="checkbox" name="smsRegistered" value="yes" />
            Cleared to send
          </label>
          <button type="submit" disabled={adding} className={BUTTON}>
            {adding ? "Adding" : "Add"}
          </button>
        </form>
      )}

      {error ? <p role="alert" className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
