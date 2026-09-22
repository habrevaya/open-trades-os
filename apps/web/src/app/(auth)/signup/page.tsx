"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@opentradesos/ui";
import { signUp, type ActionState } from "../actions";

export default function SignUpPage() {
  const [state, action, pending] = useActionState<ActionState, FormData>(signUp, {});

  return (
    <>
      <h1 className="text-xl font-semibold">Start your company</h1>
      <p className="mt-2 text-sm text-ink-700">
        This creates your company and makes you its owner. Takes about a minute.
      </p>

      <form action={action} className="mt-7 flex flex-col gap-5">
        <Field label="Your name" htmlFor="name" required error={state.fields?.name}>
          <Input id="name" name="name" autoComplete="name" required invalid={!!state.fields?.name} />
        </Field>

        <Field label="Company name" htmlFor="companyName" required error={state.fields?.companyName}
               hint="What your customers call you. You can change it later.">
          <Input id="companyName" name="companyName" autoComplete="organization" required
                 invalid={!!state.fields?.companyName} />
        </Field>

        <Field label="Work email" htmlFor="email" required error={state.fields?.email}>
          <Input id="email" name="email" type="email" autoComplete="email" required
                 invalid={!!state.fields?.email} />
        </Field>

        <Field label="Password" htmlFor="password" required error={state.fields?.password}
               hint="At least 12 characters. Length beats complexity.">
          <Input id="password" name="password" type="password" autoComplete="new-password"
                 minLength={12} required invalid={!!state.fields?.password} />
        </Field>

        {state.error && (
          <p className="rounded border border-red-600/20 bg-red-tint px-3 py-2 text-sm text-red-600" role="alert">
            {state.error}
          </p>
        )}

        <Button type="submit" variant="solid" size="lg" loading={pending} className="w-full">
          Create company
        </Button>
      </form>

      <p className="mt-6 text-sm text-ink-700">
        Already have an account?{" "}
        <a href="/login" className="text-blue-600 hover:underline">Sign in</a>
      </p>
    </>
  );
}
