"use client";

import { useActionState, useState } from "react";
import { Chip, Phone } from "@opentradesos/ui";
import { addNumber, releaseNumber } from "./actions";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";
const FIELD = "h-8 rounded border border-steel-300 px-2 text-sm";

export interface NumberRow {
  id: string;
  e164: string;
  label: string | null;
  purpose: string;
  attributionSource: string | null;
  smsRegistered: boolean;
  isSender: boolean;
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
  numbers, sources,
}: {
  numbers: NumberRow[];
  sources: { key: string; label: string }[];
}) {
  const [addState, add, adding] = useActionState(addNumber, null);
  const [releaseState, release, releasing] = useActionState(releaseNumber, null);
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState("main");

  const error = [addState, releaseState]
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
              {number.attributionSource && (
                <Chip tone="info">attributes to {number.attributionSource.replace(/_/g, " ")}</Chip>
              )}
              <Chip tone={number.smsRegistered ? "success" : "warning"}>
                {number.smsRegistered ? "Registered" : "Not registered"}
              </Chip>
              {number.isSender && <Chip tone="success">Texts come from here</Chip>}

              <form action={release} className="ml-auto">
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
        <form action={add} className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-steel-200 p-3">
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
                Calls to it count as
              </label>
              <select id="n-source" name="attributionSource" required className={`mt-1 ${FIELD}`}>
                {sources.map((source) => (
                  <option key={source.key} value={source.key}>{source.label}</option>
                ))}
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
