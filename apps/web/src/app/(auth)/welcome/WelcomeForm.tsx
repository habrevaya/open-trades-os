"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@opentradesos/ui";
import { completeWelcome, type ActionState } from "../actions";

export function WelcomeForm({ token, email, name }: { token: string; email: string; name: string | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(completeWelcome, {});

  return (
    <>
      <h1 className="text-xl font-semibold">Welcome{name ? `, ${name}` : ""}</h1>
      <p className="mt-2 text-sm text-ink-700">
        Your company is ready. Choose a password for <strong>{email}</strong> and you are in.
      </p>

      <form action={action} className="mt-7 flex flex-col gap-5">
        <input type="hidden" name="token" value={token} />
        {/* For password managers, so the new password is saved against the right account. */}
        <input type="hidden" name="username" autoComplete="username" value={email} />

        <Field label="Password" htmlFor="password" required error={state.fields?.password}
               hint="At least 12 characters. Length beats complexity.">
          <Input id="password" name="password" type="password" autoComplete="new-password"
                 minLength={12} required autoFocus invalid={!!state.fields?.password} />
        </Field>

        {state.error && (
          <p className="rounded border border-red-600/20 bg-red-tint px-3 py-2 text-sm text-red-600" role="alert">
            {state.error}
          </p>
        )}

        <Button type="submit" variant="solid" size="lg" loading={pending} className="w-full">
          Set password and sign in
        </Button>
      </form>
    </>
  );
}
