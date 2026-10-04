import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Apps, standing, type AppRow, type TokenRow } from "../src/app/(app)/settings/apps/AppsView";
import { NAV } from "../src/lib/nav";

const token = (over: Partial<TokenRow> = {}): TokenRow => ({
  id: "t1", label: "nightly sync", hint: "9xQz",
  expiresAt: "2026-12-01T00:00:00.000Z", lastUsedAt: "2026-10-01T00:00:00.000Z",
  revokedAt: null, expired: false, ...over,
});

const app = (over: Partial<AppRow> = {}): AppRow => ({
  id: "a1", name: "Neighbrium", publisher: "Neighbrium, Inc.", description: null,
  homepageUrl: null, status: "active",
  permissions: ["customer:read", "booking:read"],
  scopes: { customer: "all" },
  approvedAt: "2026-09-01T00:00:00.000Z", revokedAt: null, revokedReason: null,
  tokens: [token()], live: true, ...over,
});

/** M26's CONNECTED APPS: THE LIST THAT COULD NOT BE SEEN */
describe("the applications list", () => {
  it("shows the grant in full rather than a count", () => {
    /**
     * "Two permissions" is a number somebody nods at. The list is the thing they
     * can object to, and the screen exists so that objection is possible.
     */
    const html = renderToStaticMarkup(<Apps apps={[app()]} />);
    expect(html).toContain("customer:read");
    expect(html).toContain("booking:read");
    expect(html).not.toContain("2 permissions");
  });

  it("shows a credential by its last four and never a token", () => {
    const html = renderToStaticMarkup(<Apps apps={[app()]} />);
    expect(html).toContain("nightly sync");
    expect(html).toContain("9xQz");
    expect(html).toContain("Usable");
  });

  it("says an app with no credential is approved and not connected", () => {
    /**
     * The state in the middle, which is the one that misleads. Its status is
     * active and nothing can call us as it.
     */
    const row = app({ tokens: [], live: false });
    expect(standing(row).label).toBe("No credential");
    const html = renderToStaticMarkup(<Apps apps={[row]} />);
    expect(html).toContain("Approved, and nothing can call us as it yet");
    expect(html).toContain("None issued");
  });

  it("says why an active app with only lapsed credentials is not connected", () => {
    const row = app({ live: false, tokens: [token({ expired: true })] });
    expect(standing(row).label).toBe("Not connected");
    const html = renderToStaticMarkup(<Apps apps={[row]} />);
    expect(html).toContain("Every credential has expired");
    expect(html).toContain("Expired");
  });

  it("tells the two reasons for not connected apart", () => {
    const lapsed = app({ live: false, tokens: [token({ expired: true })] });
    const killed = app({ live: false, tokens: [token({ revokedAt: "2026-10-01T00:00:00.000Z" })] });
    expect(standing(lapsed).why).toMatch(/expired/);
    expect(standing(killed).why).toMatch(/revoked/);
  });

  it("keeps a revoked app with its reason, because what it did stays attributable", () => {
    const row = app({ status: "revoked", revokedReason: "Contract ended", live: false });
    const html = renderToStaticMarkup(<Apps apps={[row]} />);
    expect(html).toContain("Revoked");
    expect(html).toContain("Contract ended");
  });

  it("says a revoked app with no reason was still turned off deliberately", () => {
    const row = app({ status: "revoked", revokedReason: null, live: false });
    expect(standing(row).why).toMatch(/reinstall is a new approval/);
  });

  it("warns that an unnamed record scope reaches nothing", () => {
    /**
     * The sentence that saves an integrator an afternoon. An unnamed scoped
     * resource resolves to `own`, and `own` for an app matches no rows, so a list
     * comes back empty and looks like a company with no customers.
     */
    const html = renderToStaticMarkup(<Apps apps={[app({ scopes: {} })]} />);
    expect(html).toContain("No record scope named");
    expect(html).toContain("An app is not a technician");
  });

  it("names the scope it does hold", () => {
    const html = renderToStaticMarkup(<Apps apps={[app({ scopes: { customer: "all", job: "own" } })]} />);
    expect(html).toContain("customer: all");
    expect(html).toContain("job: own");
  });

  it("explains the module rather than showing an empty box", () => {
    const html = renderToStaticMarkup(<Apps apps={[]} />);
    expect(html).toContain("No applications");
    expect(html).toContain("cannot be given anything you do not hold");
  });

  it("gives each app's credential table its own name, so two cannot be confused", () => {
    const html = renderToStaticMarkup(
      <Apps apps={[app(), app({ id: "a2", name: "Other", tokens: [token({ id: "t2" })] })]} />,
    );
    expect(html).toContain('aria-label="Credentials for Neighbrium"');
    expect(html).toContain('aria-label="Credentials for Other"');
  });

  it("is reachable from the rail", () => {
    const hrefs = NAV.flatMap((g) => g.items.flatMap((i) => [i.href, ...(i.children ?? []).map((c) => c.href)]));
    expect(hrefs).toContain("/settings/apps");
  });
});

/** M26's CONSENT FLOW: AN APP THAT ASKED */
describe("an application that asked to be let in", () => {
  const request = {
    expiresAt: "2026-10-10T00:00:00.000Z", expired: false, returnsTo: "partner.example.test",
    requestedFrom: "203.0.113.7", refusedAt: null, refusedReason: null, claimedAt: null,
  };

  it("is waiting, holds nothing, and links to the page where it is decided", () => {
    const row = app({ status: "pending", source: "request", request, tokens: [], live: false, approvedAt: null });
    expect(standing(row).label).toBe("Waiting for an answer");
    const html = renderToStaticMarkup(<Apps apps={[row]} />);
    expect(html).toContain("/settings/apps/requests/a1");
    expect(html).toContain("nothing is granted until somebody approves it");
  });

  it("is expired, not waiting, once nobody answered in time", () => {
    const row = app({ status: "pending", source: "request", request: { ...request, expired: true }, tokens: [], live: false });
    expect(standing(row).label).toBe("Expired");
    expect(renderToStaticMarkup(<Apps apps={[row]} />)).not.toContain("/settings/apps/requests/a1");
  });

  it("says a refused app holds nothing, with the reason it was told", () => {
    const row = app({
      status: "refused", source: "request", tokens: [], live: false,
      request: { ...request, refusedAt: "2026-10-04T00:00:00.000Z", refusedReason: "We do not know you" },
    });
    expect(standing(row)).toMatchObject({ label: "Refused", why: "We do not know you" });
  });

  it("says an approved request collects its own credential", () => {
    const row = app({ status: "active", source: "request", request, tokens: [], live: false });
    expect(standing(row).why).toMatch(/collects its credential itself/);
  });
});
