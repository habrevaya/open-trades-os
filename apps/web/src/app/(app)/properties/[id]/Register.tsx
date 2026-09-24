"use client";

import { useActionState, useState } from "react";
import { Chip } from "@opentradesos/ui";
import { registerUnit, retireUnit } from "./actions";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";
const FIELD = "h-8 w-full rounded border border-steel-300 px-2 text-sm";

export interface Unit {
  id: string;
  tag: string | null;
  category: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  location: string | null;
  ageYears: number | null;
  warranty: {
    partsCovered: boolean;
    labourCovered: boolean;
    soonestExpiry: string | null;
    daysUntilSoonest: number | null;
  };
  children?: Unit[];
}

/**
 * THE REGISTER
 *
 * PARTS AND LABOUR ARE SHOWN SEPARATELY, always, and never collapsed into
 * "under warranty". They expire on different days, and a single badge is how
 * somebody quotes a free repair whose labour ran out four years ago. That
 * conversation with a customer is the reason the two columns exist in the
 * database, and hiding the distinction here would give it away again.
 *
 * NESTED, because assets nest: a riser has valves, a rooftop unit has a
 * compressor. Two hundred flat rows at a commercial site is a list nobody
 * reads, and the nesting is the difference between a register and a dump.
 */
export function Register({
  propertyId, units, writes,
}: {
  propertyId: string;
  units: Unit[];
  writes: boolean;
}) {
  const [addState, add, adding] = useActionState(registerUnit, null);
  const [retireState, retire, retiring] = useActionState(retireUnit, null);
  const [open, setOpen] = useState(false);

  const error = [addState, retireState]
    .map((state) => (state && "error" in state ? state.error : null))
    .find(Boolean);

  const total = count(units);

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Equipment</h2>
        {writes && (
          <button type="button" onClick={() => setOpen((was) => !was)} className={BUTTON}>
            {open ? "Cancel" : "Add a unit"}
          </button>
        )}
      </div>

      {total === 0 ? (
        <p className="mt-2 max-w-prose text-sm text-ink-700">
          Nothing on the register here. A technician can add what they find
          from the field app, or you can enter it now: the serial number is
          what keeps ten years of history attached to one unit.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {units.map((unit) => (
            <Row key={unit.id} unit={unit} depth={0} writes={writes}
                 propertyId={propertyId} retire={retire} retiring={retiring} />
          ))}
        </ul>
      )}

      {open && (
        <form action={add} className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-steel-200 p-3 sm:grid-cols-3">
          <input type="hidden" name="propertyId" value={propertyId} />
          <label className="block">
            <span className="block text-xs text-ink-500">What it is</span>
            <input name="category" required placeholder="furnace, water heater, RTU"
                   className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">Tag</span>
            <input name="tag" placeholder="RTU-4" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">Where</span>
            <input name="location" placeholder="Attic, roof, north side"
                   className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">Make</span>
            <input name="manufacturer" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">Model</span>
            <input name="model" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">
              {/*
                Said on the label, because it is the field people skip and
                the one that matters most: it is the only identifier that
                survives the customer moving out and the next owner calling.
              */}
              Serial. Keeps its history attached
            </span>
            <input name="serialNumber" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">Installed</span>
            <input name="installedOn" type="date" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">Parts warranty ends</span>
            <input name="warrantyPartsExpiresOn" type="date" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="block">
            <span className="block text-xs text-ink-500">Labour warranty ends</span>
            <input name="warrantyLaborExpiresOn" type="date" className={`mt-1 ${FIELD}`} />
          </label>
          <div className="sm:col-span-3">
            <button type="submit" disabled={adding} className={BUTTON}>
              {adding ? "Adding" : "Add it"}
            </button>
          </div>
        </form>
      )}

      {error ? <p role="alert" className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

function Row({
  unit, depth, writes, propertyId, retire, retiring,
}: {
  unit: Unit;
  depth: number;
  writes: boolean;
  propertyId: string;
  retire: (payload: FormData) => void;
  retiring: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <li className="bg-canvas p-3" style={{ paddingLeft: `${0.75 + depth * 1.5}rem` }}>
        <div className="flex flex-wrap items-baseline gap-2">
          {unit.tag && <span className="font-medium text-ink-900">{unit.tag}</span>}
          <span className="text-sm text-ink-900">{unit.category}</span>
          {(unit.manufacturer || unit.model) && (
            <span className="text-sm text-ink-700">
              {[unit.manufacturer, unit.model].filter(Boolean).join(" ")}
            </span>
          )}
          {unit.location && <span className="text-xs text-ink-500">{unit.location}</span>}
          {unit.ageYears !== null && (
            <span className="text-xs text-ink-500">{unit.ageYears} years old</span>
          )}

          {/*
            Two chips, never one. Parts and labour expire on different days,
            and a single "under warranty" is how somebody quotes a free
            repair whose labour ran out four years ago.
          */}
          <Chip tone={unit.warranty.partsCovered ? "success" : "neutral"}>
            Parts {unit.warranty.partsCovered ? "covered" : "out"}
          </Chip>
          <Chip tone={unit.warranty.labourCovered ? "success" : "neutral"}>
            Labour {unit.warranty.labourCovered ? "covered" : "out"}
          </Chip>
          {unit.warranty.daysUntilSoonest !== null
            && unit.warranty.daysUntilSoonest > 0
            && unit.warranty.daysUntilSoonest <= 90 && (
            <Chip tone="warning">
              Cover ends in {unit.warranty.daysUntilSoonest} days
            </Chip>
          )}

          <span className="ml-auto flex items-center gap-2">
            {unit.serialNumber && (
              <span className="font-mono text-xs text-ink-500">{unit.serialNumber}</span>
            )}
            {writes && (
              <button type="button" onClick={() => setConfirming((was) => !was)}
                      className={BUTTON}>
                {confirming ? "Keep it" : "Retire"}
              </button>
            )}
          </span>
        </div>

        {confirming && (
          <form action={retire} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={unit.id} />
            <input type="hidden" name="propertyId" value={propertyId} />
            <label className="sr-only" htmlFor={`why-${unit.id}`}>Why</label>
            <input id={`why-${unit.id}`} name="reason" required
                   placeholder="Why it is coming off. The next technician reads this."
                   className="h-8 min-w-72 rounded border border-steel-300 px-2 text-sm" />
            <button type="submit" disabled={retiring} className={BUTTON}>
              {retiring ? "Retiring" : "Retire it"}
            </button>
          </form>
        )}
      </li>

      {unit.children?.map((child) => (
        <Row key={child.id} unit={child} depth={depth + 1} writes={writes}
             propertyId={propertyId} retire={retire} retiring={retiring} />
      ))}
    </>
  );
}

const count = (units: Unit[]): number =>
  units.reduce((total, unit) => total + 1 + count(unit.children ?? []), 0);
