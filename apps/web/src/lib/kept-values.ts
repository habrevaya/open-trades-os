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
