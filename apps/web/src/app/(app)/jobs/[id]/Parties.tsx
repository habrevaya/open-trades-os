"use client";

import { useActionState } from "react";
import { setJobParties } from "./actions";
import { fieldNames } from "@/lib/job-parties";

export interface PartyRow {
  key: string;
  label: string;
  meaning: string;
  /** What is already recorded for this role, if anything. */
  current: { isCustomer: boolean; name: string; reference: string } | null;
}

/**
 * THE CAST, EDITED AS ONE THING
 *
 * Every role is on the form whether or not it is held, because the question
 * the screen is open to answer is "who is involved", and a list of only the
 * roles somebody already filled in cannot be used to add one.
 *
 * The whole form posts and replaces the lot. A per-role save would have to
 * merge, and a merge leaves whoever used to be the approver still holding
 * the role when somebody meant to change it.
 */
export function Parties({
  jobId, customerId, customerName, roles,
}: {
  jobId: string;
  customerId: string;
  customerName: string;
  roles: PartyRow[];
}) {
  const [state, submit, pending] = useActionState(setJobParties, null);

  return (
    <form action={submit} className="mt-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="customerId" value={customerId} />

      <div className="grid gap-3">
        {roles.map((role) => {
          // The names come from the same helper the action reads them with.
          // A form and a parser that each spell the field is a form that
          // silently posts nothing the day one of them is renamed.
          const field = fieldNames(role.key);
          return (
          <div key={role.key} className="grid gap-2 sm:grid-cols-[14rem_1fr_10rem] sm:items-start">
            <div>
              <span className="text-sm text-ink-700">{role.label}</span>
              {/*
                The meaning is beside the field rather than in a manual. The
                difference between "billed to" and "pays" is the whole reason
                this list is longer than two, and an office guessing at it
                puts the same name in both.
              */}
              <span className="block text-xs text-ink-500">{role.meaning}</span>
            </div>
            <div className="flex gap-2">
              <select
                name={field.who}
                defaultValue={role.current ? (role.current.isCustomer ? "customer" : "external") : ""}
                className="h-9 rounded border border-steel-300 px-2 text-sm"
              >
                <option value="">Nobody</option>
                <option value="customer">{customerName}</option>
                <option value="external">Someone else</option>
              </select>
              <input
                name={field.name}
                placeholder="Their name"
                defaultValue={role.current && !role.current.isCustomer ? role.current.name : ""}
                className="h-9 min-w-0 flex-1 rounded border border-steel-300 px-2 text-sm"
              />
            </div>
            <input
              name={field.reference}
              placeholder="Their reference"
              defaultValue={role.current?.reference ?? ""}
              className="h-9 rounded border border-steel-300 px-2 text-sm"
            />
          </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending}
                className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
          {pending ? "Saving" : "Save who is involved"}
        </button>
        <span className="text-xs text-ink-500">
          Leave them all on Nobody for an ordinary residential job.
        </span>
        {state && "error" in state && state.error ? (
          <span role="alert" className="text-sm text-red-600">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}
