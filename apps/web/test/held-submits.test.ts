import { describe, expect, it } from "vitest";
import { HELD_SUBMITS_SCRIPT, releaseHeldSubmits } from "@/lib/held-submits";

/**
 * No DOM here: the script and the release are run against the few pieces of
 * a page they touch, which is also the whole of what they are allowed to do.
 */
function fakeForm(connected = true) {
  const sent: unknown[] = [];
  const inside = new Set<unknown>();
  return {
    tagName: "FORM",
    isConnected: connected,
    contains: (el: unknown) => inside.has(el),
    requestSubmit: (button?: unknown) => sent.push(button ?? null),
    inside,
    sent,
  };
}

function page() {
  let listener: ((e: unknown) => void) | null = null;
  const win: Record<string, unknown> = {};
  const document = { addEventListener: (_: string, fn: (e: unknown) => void) => (listener = fn) };
  new Function("window", "document", HELD_SUBMITS_SCRIPT)(win, document);
  const submit = (target: unknown, submitter: unknown = null) => {
    let prevented = false;
    listener?.({ target, submitter, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { win: win as unknown as Window, submit };
}

describe("submits pressed before the page is ready", () => {
  it("are held, then sent once with the button that was pressed", () => {
    const { win, submit } = page();
    const form = fakeForm();
    const button = {};
    form.inside.add(button);
    expect(submit(form, button)).toBe(true);
    expect(form.sent).toEqual([]);
    expect(releaseHeldSubmits(win)).toBe(1);
    expect(form.sent).toEqual([button]);
    expect(releaseHeldSubmits(win)).toBe(0);
  });

  it("go straight through after the page is ready", () => {
    const { win, submit } = page();
    releaseHeldSubmits(win);
    expect(submit(fakeForm())).toBe(false);
  });

  it("are dropped when the form has left the page", () => {
    const { win, submit } = page();
    const gone = fakeForm(false);
    submit(gone);
    expect(releaseHeldSubmits(win)).toBe(0);
    expect(gone.sent).toEqual([]);
  });

  it("leave anything that is not a form alone", () => {
    const { submit } = page();
    expect(submit({ tagName: "DIV" })).toBe(false);
  });
});
