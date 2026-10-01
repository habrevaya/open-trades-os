import type { z } from "zod";

/**
 * WHAT A FORM'S SERVER ACTION ANSWERS
 *
 * `done` when it worked, `error` with the service's own sentence when it was
 * refused. Shared by every office form built over a service, so a refusal
 * reads the same on every screen and nothing has to invent its own shape.
 */
export type FormState = {
  done?: boolean;
  error?: string;
  values?: Record<string, string>;
  /** What happened, when the page itself does not show it: "Emailed to ...". */
  message?: string;
  /** A link the person is meant to copy and hand on, shown once. */
  link?: string;
} | null;

/**
 * The sentence a refusal carries, or null for something that is not a
 * refusal at all.
 *
 * Matched by name rather than by class, because the error classes live in
 * two packages and a bundler that duplicates one of them makes `instanceof`
 * quietly false. A refusal is something the person can act on: a conflict
 * with the state of the record, a field that cannot be what it says, a
 * permission they do not hold, a record that is not there. Anything else is
 * a bug, and it is thrown so it is seen as one rather than shown as advice.
 */
export function refusalOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  switch (error.name) {
    case "ConflictError":
    case "NotFoundError":
    case "PermissionError":
    case "PeriodClosedError":
      return error.message;
    case "UnprocessableError": {
      const issues = (error as Error & { issues?: { path: string; message: string }[] }).issues ?? [];
      return issues.length > 0 ? `${error.message}: ${issues.map((i) => i.message).join(" ")}` : error.message;
    }
    case "ZodError": {
      const issues = (error as Error & { issues?: { path: (string | number)[]; message: string }[] }).issues ?? [];
      const first = issues[0];
      if (!first) return "Something on the form is not filled in correctly.";
      const field = first.path.filter((p) => typeof p === "string").at(-1);
      return field ? `${humanise(String(field))}: ${first.message}` : first.message;
    }
    default:
      return null;
  }
}

/** `windowStart` reads as "Window start". */
function humanise(field: string): string {
  const words = field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Run a write and turn a refusal into the form's answer.
 *
 * Everything else is rethrown. The write itself is always a service call:
 * nothing in an action decides what is allowed, the service does, and the
 * action only reports it.
 */
export async function attempt(run: () => Promise<unknown>): Promise<FormState> {
  try {
    const said = await run();
    if (said && typeof said === "object" && ("message" in said || "link" in said)) {
      return { done: true, ...(said as { message?: string; link?: string }) };
    }
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return { error: message };
  }
  return { done: true };
}

/**
 * A route's input, parsed by the route's own schema.
 *
 * A server action that hands a service a hand-built object skips what the
 * HTTP layer does for every other caller: defaults (an empty technician
 * list, a quantity of one) and the limits the contract publishes. Parsing
 * through the contract makes the screen exactly as strict as the API, and a
 * ZodError it throws is a refusal `attempt` turns into a sentence.
 */
export function parsed<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  return schema.parse(input) as z.output<S>;
}

/** A trimmed form field, or undefined when it was left empty. */
export function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Every value posted under one name, trimmed, empties dropped. */
export function fields(form: FormData, name: string): string[] {
  return form.getAll(name)
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}
