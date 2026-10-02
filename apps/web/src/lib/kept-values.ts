/**
 * WHAT A REFUSED FORM HANDS BACK
 *
 * React clears a form once its action finishes, success or not. On a form
 * whose action returns an error rather than navigating, that wipes what the
 * person typed: one wrong password emptied the email box too, and somebody
 * who then retyped only the password pressed "Sign in" on a form the browser
 * would not submit, under the old "do not match" message, and could not tell
 * why nothing happened. A signup refused for a taken email lost the name and
 * the company along with it.
 *
 * The action returns the fields worth keeping and the form uses them as its
 * defaults, which is what the reset restores. Never a password: a secret is
 * not echoed back through a response, and typing it again is the point.
 */
export function keptValues(form: FormData, names: readonly string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of names) {
    const value = form.get(name);
    if (typeof value === "string" && value !== "") kept[name] = value;
  }
  return kept;
}

/**
 * Every value a refused form posted, by name, for the form to put back.
 *
 * What every office form hands back, so a form gets this without anybody
 * deciding which of its fields are worth keeping. A name posted more than
 * once (ticked technicians, the lines of an invoice) keeps every value in
 * order. Files are not kept, and neither is anything whose name says it is a
 * secret: a key pasted where its name belongs is refused, and a refusal must
 * not then carry the key back through the response. Next's own hidden
 * fields, which start with `$`, are its business.
 */
export type Kept = Record<string, string[]>;

const NEVER_KEPT = /^\$|pass(word|code)|secret|token|credential|key/i;

export function keptForm(form: FormData): Kept {
  const kept: Kept = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string" || NEVER_KEPT.test(name)) continue;
    (kept[name] ??= []).push(value);
  }
  return kept;
}

/**
 * The parts of a form field restoring needs, so this runs against a test's
 * plain objects as well as the DOM.
 */
export interface KeptField {
  name: string;
  type: string;
  value: string;
  checked?: boolean;
  multiple?: boolean;
  options?: ArrayLike<{ value: string; selected: boolean }>;
}

/**
 * Put kept values back into a form after React has reset it.
 *
 * Fields that share a name take the values in order, which is how a form
 * with repeated rows posted them. A box or a radio is ticked when its value
 * was posted under its name. Hidden fields are left alone: they belong to
 * the page, not to the person typing.
 *
 * A form whose hidden fields disagree with what was posted (the remove
 * button on a different row of the same list) is not the form that was
 * sent, and `belongsTo` says so before anything is written into it.
 */
export function restoreKept(fields: Iterable<KeptField>, kept: Kept): void {
  const seen: Record<string, number> = {};
  for (const field of fields) {
    const values = field.name ? kept[field.name] : undefined;
    if (!values) continue;
    switch (field.type) {
      case "hidden": case "file": case "submit": case "button": case "reset": case "password":
        continue;
      case "checkbox": case "radio":
        field.checked = values.includes(field.value);
        continue;
      case "select-multiple":
        for (const option of Array.from(field.options ?? [])) option.selected = values.includes(option.value);
        continue;
      default: {
        const index = seen[field.name] ?? 0;
        seen[field.name] = index + 1;
        const value = values[index];
        if (value !== undefined) field.value = value;
      }
    }
  }
}

/** Whether the hidden fields of a form match what was posted, so it is the one that was sent. */
export function belongsTo(fields: Iterable<KeptField>, kept: Kept): boolean {
  for (const field of fields) {
    if (field.type !== "hidden" || !field.name || NEVER_KEPT.test(field.name)) continue;
    const values = kept[field.name];
    if (!values || !values.includes(field.value)) return false;
  }
  return true;
}
