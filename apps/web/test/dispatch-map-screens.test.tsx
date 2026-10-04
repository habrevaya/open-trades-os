import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DispatchMap, type MapData } from "../src/app/(app)/schedule/DispatchMap";
import { RoutePreview, Suggestions } from "../src/app/(app)/schedule/Proposals";
import { tileSource } from "../src/lib/map-tiles";

/**
 * THE DISPATCH MAP AND THE OPTIMISER'S PREVIEW, AS MARKUP
 *
 * The map itself draws nothing until it knows its own size in a browser, so
 * what is checked here is everything around it: the list of visits that are
 * not on the map, which must never be dropped, the attribution the tile
 * server's terms require, and the sentences the preview uses for a window
 * that cannot be kept.
 */

const T1 = "00000000-0000-4000-8000-000000000001";
const V1 = "00000000-0000-4000-8000-000000000011";
const V2 = "00000000-0000-4000-8000-000000000012";
const P2 = "00000000-0000-4000-8000-000000000022";

const visit = (over: Partial<MapData["visits"][number]>): MapData["visits"][number] => ({
  id: V1, jobId: V1, jobNumber: 41, summary: "No cool", customerName: "Dana Whitfield",
  propertyId: V1, address: "4102 Ramsey Ave, Austin", status: "dispatched",
  windowStart: "2026-10-05T14:00:00.000Z", windowEnd: "2026-10-05T16:00:00.000Z",
  estimatedDurationMinutes: 60, routeOrder: 1, isLate: false,
  technicianId: T1, technicianIds: [T1], crewId: null, locked: false,
  position: { lat: 30.31, lng: -97.74, precision: "rooftop", source: "nominatim" },
  ...over,
});

const map = (over: Partial<MapData> = {}): MapData => ({
  date: "2026-10-05",
  timezone: "America/Chicago",
  technicians: [{
    id: T1, displayName: "Ray Ortiz", color: "#1D4ED8", timeOff: false,
    start: null, startIsCompanyDefault: true, route: [V1],
  }],
  visits: [
    visit({}),
    visit({ id: V2, jobNumber: 42, customerName: "Tolu Okafor", propertyId: P2, address: "7300 Hart Ln, Austin",
            technicianId: null, technicianIds: [], status: "unassigned", position: null }),
  ],
  unplaced: [V2],
  crews: [],
  travel: { averageKmh: 40, roadFactor: 1.3, dayStartsAt: "08:00" },
  geocoder: null,
  routing: null,
  live: null,
  ...over,
});

const render = (data: MapData) => renderToStaticMarkup(
  <DispatchMap map={data} tiles={tileSource({})} canDispatch time={(iso) => iso} onAssign={() => {}} />,
);

describe("the dispatch map", () => {
  it("lists crews beside the people, and where people are now for somebody who dispatches", () => {
    const html = render(map({
      crews: [{ id: "c1", name: "Install crew", color: null, start: null, memberIds: [T1], route: [V1] }],
      live: {
        enabled: true,
        positions: [{
          technicianId: T1, displayName: "Ray Ortiz", color: "#1D4ED8", lat: 30.3, lng: -97.7, accuracyMeters: 8,
          recordedAt: "2026-10-05T15:00:00.000Z", reason: "on_the_way", visitId: V1, freshness: "stale", lastSeen: "2 hours ago",
        }],
      },
    }));
    expect(html).toContain("Install crew");
    expect(html).toContain("Crew, 1 stop");
    expect(html).toContain("Where people are now");
    expect(html).toContain("2 hours ago");
  });

  it("says live location is off, with where to turn it on, and shows nothing to somebody who does not dispatch", () => {
    expect(render(map({ live: { enabled: false, positions: [] } }))).toContain("Live location is off.");
    expect(render(map({ live: null }))).not.toContain("Where people are now");
  });

  it("lists a visit with no coordinates, with a link to place its pin, rather than dropping it", () => {
    const html = render(map());
    expect(html).toContain("Not on the map yet (1)");
    expect(html).toContain("Tolu Okafor");
    expect(html).toContain(`href="/properties/${P2}#pin"`);
  });

  it("credits the tile server on the map itself", () => {
    const html = render(map());
    expect(html).toContain("© OpenStreetMap contributors");
    expect(html).toContain("https://www.openstreetmap.org/copyright");
  });

  it("says when no geocoder is connected, and where to connect one", () => {
    expect(render(map())).toContain("/settings/integrations");
    expect(render(map({ geocoder: "nominatim" }))).not.toContain("No geocoder is connected");
  });

  it("says when somebody's day has no start on the map", () => {
    expect(render(map())).toContain("Set where days start");
  });

  it("reads its tiles from configuration, with OpenStreetMap as the default", () => {
    expect(tileSource({}).url).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(tileSource({ MAP_TILE_URL: "https://tiles.example/{z}/{x}/{y}.png", MAP_TILE_ATTRIBUTION: "Example" }))
      .toMatchObject({ url: "https://tiles.example/{z}/{x}/{y}.png", attribution: "Example" });
  });
});

describe("the optimiser's preview", () => {
  const day = (driveMinutes: number) => ({
    order: [V1], driveMinutes, waitMinutes: 0, lateCount: 0, lateMinutes: 0, finishAt: "2026-10-05T22:00:00.000Z",
  });
  const proposal = {
    technicianId: T1, date: "2026-10-05", startKnown: true, startLabel: "Yard",
    current: day(52), proposed: day(31), improved: true,
    missed: [{ visitId: V2, customerName: "Tolu Okafor", lateByMinutes: 25, unreachable: true }],
    locked: [], pinned: [], unplaced: [], applyOrder: [V1, V2], declaredLegs: 0,
    travel: { averageKmh: 40, roadFactor: 1.3, dayStartsAt: "08:00" },
    driveSource: "estimate" as const,
    driveNote: "Drive times are straight line estimates. Connect a routing service under Settings, Integrations for times by road.",
  };
  const names = new Map([[V1, "Dana Whitfield"], [V2, "Tolu Okafor"]]);

  it("shows the drive before and after, and the window it cannot keep", () => {
    const html = renderToStaticMarkup(
      <RoutePreview proposal={proposal} technicianName="Ray Ortiz" customerOf={names} canApply onApply={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("About 52 min driving now, about 31 min in this order: 21 min less.");
    expect(html).toContain("Tolu Okafor: about 25 min after the window closes.");
    expect(html).toContain("No order could make it");
    expect(html).toContain("Use this order");
  });

  it("says when the drive times are by road, and that a locked visit keeps its place", () => {
    const html = renderToStaticMarkup(
      <RoutePreview
        proposal={{ ...proposal, driveSource: "road", driveNote: "Drive times by road, from your OSRM server.", pinned: [V1] }}
        technicianName="Ray Ortiz" customerOf={names} canApply onApply={() => {}} onClose={() => {}}
      />,
    );
    expect(html).toContain("Drive times by road, from your OSRM server.");
    expect(html).not.toContain("straight line");
    expect(html).toContain("1 locked visit keeps its place.");
  });

  it("does not offer to apply an order that is no better", () => {
    const html = renderToStaticMarkup(
      <RoutePreview proposal={{ ...proposal, improved: false, missed: [] }} technicianName="Ray Ortiz"
                    customerOf={names} canApply onApply={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("already the best");
    expect(html).not.toContain("Use this order");
  });

  it("names everybody a suggestion considered, with the reason somebody was ruled out", () => {
    const html = renderToStaticMarkup(
      <Suggestions
        suggested={{
          date: "2026-10-05",
          suggestions: [{
            visitId: V2, customerName: "Tolu Okafor", technicianId: T1, technicianName: "Ray Ortiz",
            position: 2, addedDriveMinutes: 12, wouldBeLate: [], unknownSkills: [],
            considered: [
              { technicianId: T1, technicianName: "Ray Ortiz", addedDriveMinutes: 12, makesLate: false, refused: null },
              { technicianId: V1, technicianName: "Sam Reyes", addedDriveMinutes: null, makesLate: false,
                refused: "Sam Reyes cannot be sent: this work needs gas-fitting." },
            ],
          }],
          unplaced: [],
          driveSource: "estimate",
          driveNote: "Drive times are straight line estimates.",
        }}
        customerOf={names}
        onAccept={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Ray Ortiz, stop 2, adds about 12 min driving.");
    expect(html).toContain("Assign to Ray Ortiz");
    expect(html).toContain("Sam Reyes cannot be sent");
  });
});
