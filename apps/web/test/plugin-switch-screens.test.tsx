import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Apps, type AppRow, type PluginRow } from "../src/app/(app)/settings/apps/AppsView";
import { SwitchPlugin } from "../src/app/(app)/settings/apps/added/SwitchPlugin";
import { NAV } from "../src/lib/nav";

vi.mock("../src/app/(app)/settings/apps/actions", () => ({ act: vi.fn() }));

/**
 * THE COMPANY'S OWN SWITCH FOR EACH THING AN APPLICATION ADDED
 *
 * On the Applications screen the state of each plugin is said in words that
 * tell the three reasons for "off" apart, because the cure for each is
 * different: turn it on here, turn the application on there, or wait for the
 * application to register it again. The switch itself names the row it is on.
 */
const plugin = (over: Partial<PluginRow> = {}): PluginRow => ({
  id: "p1", kind: "pricing_rule", key: "vip", name: "VIP discount", version: 2,
  summary: "10% off for customers tagged \"vip\".", on: true, state: "on", retiredAt: null,
  registeredAt: "2026-09-01T00:00:00.000Z", changedAt: "2026-09-02T00:00:00.000Z", ...over,
});

const app = (plugins: PluginRow[]): AppRow => ({
  id: "a1", name: "Pricer", publisher: null, description: null, homepageUrl: null, status: "active",
  permissions: ["pricebook:write"], scopes: {}, approvedAt: "2026-09-01T00:00:00.000Z", revokedAt: null, revokedReason: null,
  tokens: [], live: true, plugins,
});

describe("what an application added, on the Applications screen", () => {
  it("tells off because the company turned it off from off because the application is", () => {
    const html = renderToStaticMarkup(<Apps apps={[app([
      plugin(),
      plugin({ id: "p2", name: "Stopped here", on: false, state: "turned_off" }),
      plugin({ id: "p3", name: "App is off", on: false, state: "app_off" }),
      plugin({ id: "p4", name: "Gone", on: false, state: "removed", retiredAt: "2026-09-03T00:00:00.000Z" }),
    ])]} />);
    expect(html).toContain("Turned off by you");
    expect(html).toContain("Off: the app is turned off");
    expect(html).toContain("Removed by the app");
    expect(html).toContain("On</");
  });

  it("points at the page where one is stopped without stopping the application", () => {
    const html = renderToStaticMarkup(<Apps apps={[app([plugin()])]} />);
    expect(html).toContain('href="/settings/apps/added"');
  });
});

describe("the switch on one row", () => {
  it("offers Turn off with a box for why, both named for the row", () => {
    const html = renderToStaticMarkup(<SwitchPlugin id="p1" name="VIP discount" on />);
    expect(html).toContain("Turn off");
    expect(html).toContain('aria-label="Why VIP discount is being turned off"');
    expect(html).toContain('name="op" value="plugin-off"');
    expect(html).toContain('name="id" value="p1"');
  });

  it("offers Turn on, and no box, for one that is off", () => {
    const html = renderToStaticMarkup(<SwitchPlugin id="p1" name="VIP discount" on={false} />);
    expect(html).toContain("Turn on");
    expect(html).not.toContain("Why");
    expect(html).toContain('name="op" value="plugin-on"');
  });

  it("is reachable from the rail, under Applications", () => {
    const settings = NAV.flatMap((g) => g.items).find((i) => i.href === "/settings")!;
    const hrefs = (settings.children ?? []).map((c) => c.href);
    expect(hrefs).toContain("/settings/apps/added");
    expect(hrefs.indexOf("/settings/apps/added")).toBe(hrefs.indexOf("/settings/apps") + 1);
  });
});
