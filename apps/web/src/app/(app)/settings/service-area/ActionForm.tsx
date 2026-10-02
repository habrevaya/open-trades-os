"use client";

import { OpForm } from "@/components/OpForm";
import { act } from "./actions";

export function NewTerritory() {
  return (
    <OpForm action={act} op="create" label="Add territory">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-700">Name</span>
        <input name="name" required placeholder="North side"
               className="h-9 w-48 rounded border border-steel-300 px-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-700">Postal codes</span>
        <input name="postalCodes" placeholder="78701, 78702, 78703"
               aria-label="Postal codes for the new territory"
               className="h-9 w-72 rounded border border-steel-300 px-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-700">Trip charge</span>
        <input name="travelFee" inputMode="decimal" placeholder="Company default"
               aria-label="Trip charge for the new territory"
               className="h-9 w-36 rounded border border-steel-300 px-2" />
      </label>
    </OpForm>
  );
}

export function EditTerritory({
  id, name, postalCodes, travelFee,
}: { id: string; name: string; postalCodes: string; travelFee: string }) {
  return (
    <OpForm action={act} op="edit" label="Save" quiet hidden={{ id }}>
      <input name="name" defaultValue={name} aria-label={`Name of ${name}`}
             className="h-8 w-36 rounded border border-steel-300 px-2 text-sm" />
      <input name="postalCodes" defaultValue={postalCodes} aria-label={`Postal codes for ${name}`}
             className="h-8 w-56 rounded border border-steel-300 px-2 text-sm" />
      <input name="travelFee" defaultValue={travelFee} inputMode="decimal"
             aria-label={`Trip charge for ${name}`} placeholder="Company default"
             className="h-8 w-28 rounded border border-steel-300 px-2 text-sm" />
    </OpForm>
  );
}

export function SetActive({ id, active, name }: { id: string; active: boolean; name: string }) {
  return (
    <OpForm
      action={act}
      op={active ? "retire" : "restore"}
      label={active ? "Retire" : "Put back"}
      quiet
      hidden={{ id }}
      className="inline-flex"
    >
      <input type="hidden" name="territoryName" value={name} />
    </OpForm>
  );
}
