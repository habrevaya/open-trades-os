import { describe, it, expect } from "vitest";
import { serverPage, tappedNotice } from "../src/lib/push";
import { withFocus } from "../src/lib/work";

/**
 * WHAT A TAP ON A NOTICE OPENS
 *
 * A change to the day opens its visit, as it always did. A notice about a
 * person's own work opens the task or visit the phone holds, the talks or the
 * expenses screens, and anything else in the browser at the page the bell
 * would open. Decided from the data the server sent, in Node.
 */
const NOTICE = "6f1c2b9e-0a4d-4f39-9c7e-2b8a1d3e5f60";
const TASK = "0b9a7d1e-5c2f-4d83-8a6b-3e4f5a6b7c8d";

describe("a notice about a person's own work", () => {
  it("opens the task it names, and marks the notice read", () => {
    expect(tappedNotice({ noticeId: NOTICE, kind: "task_assigned", href: `/tasks/${TASK}`, about: { type: "task", id: TASK } }))
      .toEqual({ noticeId: NOTICE, target: { open: "task", taskId: TASK, href: `/tasks/${TASK}` } });
  });

  it("opens a visit when the record is one", () => {
    expect(tappedNotice({ noticeId: NOTICE, about: { type: "visit", id: TASK }, href: "/jobs/1" }))
      .toEqual({ noticeId: NOTICE, target: { open: "visit", visitId: TASK } });
  });

  it("opens the screens the phone has for a talk and for an expense", () => {
    expect(tappedNotice({ noticeId: NOTICE, about: { type: "safety_meeting", id: TASK }, href: "/my-day" })?.target).toEqual({ open: "talks" });
    expect(tappedNotice({ noticeId: NOTICE, about: { type: "expense", id: TASK }, href: "/me/expenses" })?.target).toEqual({ open: "expenses" });
  });

  it("opens the notice's own page in the browser for any other kind", () => {
    expect(tappedNotice({ noticeId: NOTICE, about: { type: "purchase_order", id: TASK }, href: `/purchasing/${TASK}` }))
      .toEqual({ noticeId: NOTICE, target: { open: "browser", href: `/purchasing/${TASK}` } });
    expect(tappedNotice({ noticeId: NOTICE, about: { type: "person_certification", id: TASK }, href: "/me" })?.target)
      .toEqual({ open: "browser", href: "/me" });
  });
});

describe("a change to the day", () => {
  it("opens the visit and has no notice to mark", () => {
    expect(tappedNotice({ visitId: TASK, kind: "cancelled" })).toEqual({ noticeId: null, target: { open: "visit", visitId: TASK } });
  });
});

describe("anything that is not ours", () => {
  it("opens nothing", () => {
    expect(tappedNotice(null)).toBeNull();
    expect(tappedNotice("task")).toBeNull();
    expect(tappedNotice({})).toBeNull();
    expect(tappedNotice({ noticeId: NOTICE, about: { type: "purchase_order", id: TASK } })).toBeNull();
  });

  it("never sends the phone to another address", () => {
    for (const href of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "tasks/1", "/a\nb", `/${"x".repeat(400)}`]) {
      expect(tappedNotice({ noticeId: NOTICE, about: { type: "purchase_order", id: TASK }, href }), href).toBeNull();
    }
  });

  it("ignores a notice id that is not an id, and still opens the task", () => {
    expect(tappedNotice({ noticeId: "../x", about: { type: "task", id: TASK }, href: null }))
      .toEqual({ noticeId: null, target: { open: "task", taskId: TASK, href: null } });
    expect(tappedNotice({ noticeId: NOTICE, about: { type: "task", id: "not-an-id" }, href: "/tasks/x" })?.target)
      .toEqual({ open: "browser", href: "/tasks/x" });
  });
});

describe("the page in the browser", () => {
  it("sits under the company's server, whatever path it is served from", () => {
    expect(serverPage("https://ops.example.com", "/purchasing/1")).toBe("https://ops.example.com/purchasing/1");
    expect(serverPage("https://ops.example.com/app/", "/me")).toBe("https://ops.example.com/app/me");
    expect(serverPage("https://ops.example.com", "https://evil.example/")).toBeNull();
  });
});

describe("the tasks screen opened from a notice", () => {
  const tasks = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("puts the task first and leaves the rest in order", () => {
    expect(withFocus(tasks, "c")).toEqual({ focused: { id: "c" }, rest: [{ id: "a" }, { id: "b" }], missing: false });
  });

  it("says when the phone does not hold it", () => {
    expect(withFocus(tasks, "z")).toEqual({ focused: null, rest: tasks, missing: true });
  });

  it("is the plain list when no notice was tapped", () => {
    expect(withFocus(tasks, null)).toEqual({ focused: null, rest: tasks, missing: false });
  });
});
