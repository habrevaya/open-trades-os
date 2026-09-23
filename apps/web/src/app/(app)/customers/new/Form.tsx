"use client";

import { useActionState } from "react";
import { createCustomer } from "../actions";

/**
 * A plain form that posts to a server action.
 *
 * No client-side validation beyond what the browser does for free. The rules
 * live in one schema on the server, and a second copy here would be a second
 * thing to keep in step for the sake of saving one round trip.
 */
export function NewCustomerForm() {
  const [state, action, pending] = useActionState(createCustomer, null);

  return (
    <form action={action} className="mt-6 space-y-5">
      {state?.error ? (
        <p role="alert" className="rounded border border-red-600/20 bg-red-tint px-3 py-2 text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <Field label="Name" name="name" required autoComplete="name" />

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium">Type</span>
          <select name="type" defaultValue="residential"
                  className="mt-1 h-10 w-full rounded border border-steel-300 px-3 text-sm">
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
          </select>
        </label>
        <Field label="Phone" name="phone" type="tel" autoComplete="tel" />
      </div>

      <Field label="Email" name="email" type="email" autoComplete="email" />

      <fieldset className="space-y-5 rounded-md border border-steel-200 p-4">
        <legend className="px-1 text-sm font-medium">Service address</legend>
        <Field label="Street" name="line1" autoComplete="address-line1" />
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="City" name="city" autoComplete="address-level2" />
          <Field label="State" name="state" autoComplete="address-level1" />
          <Field label="ZIP" name="postalCode" autoComplete="postal-code" inputMode="numeric" />
        </div>
      </fieldset>

      <div className="flex gap-3">
        <button type="submit" disabled={pending}
                className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white transition-colors hover:bg-ink-700 disabled:opacity-60">
          {pending ? "Saving" : "Save customer"}
        </button>
        <a href="/customers"
           className="inline-flex h-10 items-center rounded border border-steel-300 px-3.5 text-sm font-medium">
          Cancel
        </a>
      </div>
    </form>
  );
}

function Field({
  label, name, ...rest
}: { label: string; name: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input name={name} {...rest}
             className="mt-1 h-10 w-full rounded border border-steel-300 px-3 text-sm" />
    </label>
  );
}
