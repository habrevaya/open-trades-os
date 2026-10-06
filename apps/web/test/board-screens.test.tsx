import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../src/app/(app)/schedule/actions", () => ({
  assignVisit: vi.fn(), reorderDay: vi.fn(), proposeRoute: vi.fn(), suggestAssignments: vi.fn(),
  lockVisit: vi.fn(), livePositions: vi.fn(),
}));

import { Board } from "../src/app/(app)/schedule/Board";
import { tileSource } from "../src/lib/map-tiles";

/**
 * THE BOARD'S DAY, AS MARKUP: crews in lanes of their own rather than in
 * the unassigned pile, the routes running, the rota in words, and a locked
 * visit saying so.
 */

const T1 = "00000000-0000-4000-8000-000000000001";
const C1 = "00000000-0000-4000-8000-000000000031";
const V1 = "00000000-0000-4000-8000-000000000011";
const V2 = "00000000-0000-4000-8000-000000000012";

const card = (over: Record<string, unknown> = {}) => ({
  id: V1, jobNumber: 41, summary: "No cool", status: "dispatched",
  windowStart: "2026-10-05T14:00:00.000Z", windowEnd: "2026-10-05T16:00:00.000Z",
  routeOrder: 1, estimatedDurationMinutes: 60, customerName: "Dana Whitfield", addressLine1: "4102 Ramsey Ave",
  isLate: false, routeName: null, locked: false, ...over,
});

type BoardProps = Parameters<typeof Board>[0];

const render = (board: Partial<BoardProps["board"]>, canDispatch = true) => renderToStaticMarkup(
  <Board
    board={{
      date: "2026-10-05", technicians: [{ id: T1, displayName: "Ray Ortiz", color: null, timeOff: false, visits: [card({ locked: true, routeName: "Tuesday pools" })] }],
      unassigned: [], crews: [], routes: [], onCall: [], ...board,
    } as BoardProps["board"]}
    date="2026-10-05" today="2026-10-05" view="board" map={null} tiles={tileSource({})}
    canDispatch={canDispatch} canReorder timezone="America/Chicago"
  />,
);

describe("the board's day", () => {
  it("puts crew work in the crew's own lane, with its lead", () => {
    const html = render({
      crews: [{ id: C1, name: "Install crew", color: null, leadName: "Nia Osei", memberNames: ["Nia Osei", "Sam Reyes"], visits: [card({ id: V2, customerName: "Tolu Okafor" })] }],
    });
    expect(html).toContain('aria-label="Crew Install crew"');
    expect(html).toContain("Led by Nia Osei, 2 people");
    expect(html).toContain("Tolu Okafor");
    expect(html).not.toContain("unassigned</span>");
  });

  it("says nobody is on call in words, and names who is when somebody is", () => {
    expect(render({})).toContain("Nobody is on call today.");
    const html = render({ onCall: [{ technicianName: "Sam Reyes", startsAt: "2026-10-05T22:00:00.000Z", endsAt: "2026-10-06T13:00:00.000Z" }] });
    expect(html).toContain("On call: <span class=\"font-medium\">Sam Reyes</span>");
  });

  it("shows the routes running and how far through them the day is", () => {
    const html = render({ routes: [{ id: C1, name: "Tuesday pools", stops: 12, done: 3, runBy: "Ray Ortiz" }] });
    expect(html).toContain("3 of 12 done, Ray Ortiz");
  });

  it("marks a stop's route and its lock, and offers the rebalance to somebody who dispatches", () => {
    const html = render({});
    expect(html).toContain("Route: Tuesday pools");
    expect(html).toContain("Unlock Dana Whitfield&#x27;s visit");
    expect(html).toContain('href="/schedule/rebalance?date=2026-10-05"');
    expect(render({}, false)).not.toContain("Rebalance the day");
  });
});
