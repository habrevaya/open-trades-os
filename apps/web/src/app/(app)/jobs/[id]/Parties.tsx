"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { setJobParties } from "./actions";
import { fieldNames, ACCOUNT } from "@/lib/job-parties";

export interface PartyRow {
  key: string;
  label: string;
  meaning: string;
  /** What is already recorded for this role, if anything. */
  current: {
    isCustomer: boolean; name: string; reference: string;
    /** The record held, when it is not the job's own customer: a payer account. */
    accountId?: string | null; share?: string;
  } | null;
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
  jobId, customerId, customerName, roles, accounts = [],
}: {
  jobId: string;
  customerId: string;
  customerName: string;
  roles: PartyRow[];
  /**
   * Customers who pay for other people's work: a warranty company, a client
   * with a contract. Offered by name, so the payer is their record and
   * their invoices age against them.
   */
  accounts?: { id: string; name: string }[];
}) {
  const [state, submitForm, pending] = useKeptAction(setJobParties, null);

  return (
    <form {...submitForm} className="mt-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="customerId" value={customerId} />

      <div className="grid gap-3">
        {roles.map((role) => {
          // The names come from the same helper the action reads them with.
          // A form and a parser that each spell the field is a form that
          // silently posts nothing the day one of them is renamed.
          const field = fieldNames(role.key);
          return (
          <div key={role.key} className="grid gap-2 sm:grid-cols-[14rem_1fr_18rem] sm:items-start">
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
                aria-label={role.label}
                defaultValue={role.current
                  ? (role.current.accountId ? `${ACCOUNT}${role.current.accountId}` : role.current.isCustomer ? "customer" : "external")
                  : ""}
                className="h-9 rounded border border-steel-300 px-2 text-sm"
              >
                <option value="">Nobody</option>
                <option value="customer">{customerName}</option>
                {accounts.filter((a) => a.id !== customerId).map((account) => (
                  <option key={account.id} value={`${ACCOUNT}${account.id}`}>{account.name}</option>
                ))}
                <option value="external">Someone else</option>
              </select>
              <input
                name={field.name}
                placeholder="Their name"
                defaultValue={role.current && !role.current.isCustomer ? role.current.name : ""}
                className="h-9 min-w-0 flex-1 rounded border border-steel-300 px-2 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <input
                name={field.reference}
                placeholder="Their reference"
                defaultValue={role.current?.reference ?? ""}
                className="h-9 min-w-0 flex-1 rounded border border-steel-300 px-2 text-sm"
              />
              {/*
                Only the payer has a share: they pay it, and whoever the job
                is billed to pays the rest. Empty for a payer who pays it all,
                or for covered work, where the coverage decides the split.
              */}
              {role.key === "payer" && (
                <input
                  name={field.share}
                  aria-label="Their share"
                  placeholder="Share: 70% or 150.00"
                  defaultValue={role.current?.share ?? ""}
                  className="h-9 w-40 rounded border border-steel-300 px-2 text-sm"
                />
              )}
            </div>
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
