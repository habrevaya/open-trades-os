import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticeBell, type Bell } from "../src/components/NoticeBell";

/**
 * M34 ON A SCREEN: THE BELL
 *
 * Who is told what is the server's (packages/api/test/staff-notices
 * .integration.test.ts). This checks what the person reads: the count, each
 * notice as a link to its record through `/notices/{id}`, read or unread in
 * words a screen reader says, and that the shell shows the bell.
 */
const bell = (over: Partial<Bell> = {}): Bell => ({
  unread: 1,
  notices: [
    {
      id: "11111111-1111-4111-8111-111111111111", kind: "po_approval", kindLabel: "An order waiting for your approval",
      title: "Purchase order 1042 is waiting for your approval", body: "To Ferguson, for $1,800.00.",
      href: "/purchasing/x", createdAt: "2026-10-06T19:30:00.000Z", readAt: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222", kind: "expense_decided", kindLabel: "Your expense answered",
      title: "Your $18.00 expense was approved", body: null,
      href: "/me/expenses", createdAt: "2026-10-05T15:00:00.000Z", readAt: "2026-10-05T16:00:00.000Z",
    },
  ],
  ...over,
});

describe("the bell", () => {
  it("counts the unread and lists each notice as a link that opens it", () => {
    const html = renderToStaticMarkup(
      <NoticeBell bell={bell()} timezone="America/Chicago" placement="rail" markAllRead={async () => {}} />,
    );
    expect(html).toContain('aria-label="Notices, 1 unread"');
    expect(html).toContain('href="/notices/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("Purchase order 1042 is waiting for your approval");
    expect(html).toContain("An order waiting for your approval, Tue, Oct 6, 2:30 PM");
    expect(html).toContain(", unread");
    expect(html).toContain(", read");
    expect(html).toContain("Mark all read");
    expect(html).toContain('href="/notices"');
    expect(html).toContain('href="/me#notices"');
  });

  it("says when there is nothing, and offers no button with nothing to mark", () => {
    const html = renderToStaticMarkup(
      <NoticeBell bell={{ unread: 0, notices: [] }} timezone="America/Chicago" placement="header" markAllRead={async () => {}} />,
    );
    expect(html).toContain('aria-label="Notices, none unread"');
    expect(html).toContain("Nothing yet.");
    expect(html).not.toContain("Mark all read");
  });

  it("caps the count it shows", () => {
    const html = renderToStaticMarkup(<NoticeBell bell={bell({ unread: 140 })} timezone="America/Chicago" placement="header" />);
    expect(html).toContain("99+");
  });

  it("is in the shell, in the rail and in the phone's bar, for whoever has a bell", () => {
    const shell = readFileSync(join(import.meta.dirname, "../src/components/AppShell.tsx"), "utf8");
    expect(shell).toContain('placement="rail"');
    expect(shell).toContain('placement="header"');
  });
});
