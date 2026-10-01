"use client";

import { useActionState, useCallback, useLayoutEffect, useRef } from "react";
import { belongsTo, restoreKept, type Kept, type KeptField } from "./kept-values";

/**
 * EVERY FORM KEEPS WHAT WAS TYPED WHEN IT IS REFUSED
 *
 * React resets a form once its action finishes, success or not, which on a
 * refusal empties every box under the message explaining what to fix. The
 * server action hands back what was posted (`refused` and `attempt` in
 * lib/actions.ts do it for every office form), and this puts it back after
 * the reset: the reset happens as the action's result commits, and a layout
 * effect runs after that commit and before the browser paints, so the boxes
 * are never seen empty.
 *
 * Use it in place of `useActionState` and spread the second value onto the
 * form: `<form {...form}>`. A test fails for any file that imports
 * `useActionState` directly, so a new form gets this without anybody having
 * to remember it.
 *
 * One action can drive several forms (a remove button on every row), so the
 * forms register themselves and the values go back only into the one whose
 * hidden fields match what was posted.
 */
/** What is spread onto a form, and handed down to a row that draws its own. */
export interface KeptFormProps {
  action: (form: FormData) => void;
  ref: (element: HTMLFormElement | null) => (() => void) | undefined;
}

type WithKept = { values?: Kept | Record<string, string> | undefined } | null | undefined;

export function useKeptAction<State>(
  action: (previous: Awaited<State>, form: FormData) => State | Promise<State>,
  initial: Awaited<State>,
) {
  const [state, dispatch, pending] = useActionState(action, initial);
  const forms = useRef(new Set<HTMLFormElement>());
  const ref = useCallback((element: HTMLFormElement | null) => {
    if (!element) return;
    forms.current.add(element);
    return () => { forms.current.delete(element); };
  }, []);

  useLayoutEffect(() => {
    const values = (state as WithKept)?.values;
    if (!values) return;
    const kept: Kept = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, Array.isArray(value) ? value : [value]]),
    );
    for (const form of forms.current) {
      const fields = Array.from(form.elements) as unknown as KeptField[];
      if (belongsTo(fields, kept)) restoreKept(fields, kept);
    }
  }, [state]);

  const form: KeptFormProps = { action: dispatch, ref };
  return [state, form, pending] as const;
}
