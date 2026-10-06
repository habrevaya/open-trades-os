/**
 * PLACEHOLDER RENDERING
 *
 * One renderer for every piece of copy this product sends, and it lives here
 * rather than in a service because two of them now need it: the workflow
 * engine, which has had it since it was built, and the message templates an
 * operator edits.
 *
 * It was in `services/workflow-steps.ts`, and leaving it there meant the
 * template service imported the step executor while the step executor
 * imported the template service. That cycle happens to work today because
 * neither calls the other at module scope, and it stops working silently the
 * first time somebody adds a top level constant derived from an import. The
 * same trap `audit` was moved out of `customers.ts` to avoid.
 *
 * TWO RENDERERS WOULD BE WORSE THAN THE CYCLE. A template that previews with
 * one and sends with the other is a difference nobody finds until a customer
 * reads the wrong sentence, so there is exactly one of these and both callers
 * import it.
 */
import { work } from "@opentradesos/core";

/**
 * Fills `{{ job.summary }}` style placeholders from the event payload.
 *
 * Substitution only. No expressions, no function calls, nothing evaluated,
 * for the same reason conditions are data: a template language that executes
 * is arbitrary code execution wearing a friendly name, in a product a
 * contractor self hosts.
 *
 * An unresolved placeholder becomes an empty string rather than being left
 * as literal braces, because "Hi {{ customer.name }}" reaching a customer is
 * worse than "Hi ".
 */
export function render(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    const value = readPath(scope, path);
    if (value === null || value === undefined) return "";
    return printedNumber(scope, path, value) ?? String(value);
  });
}

/**
 * A JOB OR INVOICE NUMBER AS IT IS PRINTED. `{{ job.number }}` read off a job
 * that carries its branch's code (`number_prefix`, written when it was made)
 * is "HOU-1042", the way the job page, the PDF and the email print it; a
 * text quoting the bare 1042 is a number the customer cannot find on their
 * paperwork. A record with no code prints its number alone, as before.
 */
function printedNumber(scope: Record<string, unknown>, path: string, value: unknown): string | null {
  const parts = path.split(".");
  if (parts[parts.length - 1] !== "number" || parts.length < 2) return null;
  const prefix = readPath(scope, [...parts.slice(0, -1), "numberPrefix"].join("."));
  return typeof prefix === "string" && prefix !== "" && (typeof value === "number" || typeof value === "string")
    ? work.documentNumber(prefix, value)
    : null;
}

/** Exported because the step executor reads event payloads with the same path rules. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
