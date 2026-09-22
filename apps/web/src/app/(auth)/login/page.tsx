"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@opentradesos/ui";
import { signIn, type ActionState } from "../actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState<ActionState, FormData>(signIn, {});

  return (
    <>
      <h1 className="text-xl font-semibold">Sign in</h1>

      <form action={action} className="mt-7 flex flex-col gap-5">
        <Field label="Work email" htmlFor="email" required>
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </Field>

        <Field label="Password" htmlFor="password" required>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>

        {state.error && (
          <p className="rounded border border-red-600/20 bg-red-tint px-3 py-2 text-sm text-red-600" role="alert">
            {state.error}
          </p>
        )}

        <Button type="submit" variant="solid" size="lg" loading={pending} className="w-full">
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-sm text-ink-700">
        New here?{" "}
        <a href="/signup" className="text-blue-600 hover:underline">Start your company</a>
      </p>
    </>
  );
}
