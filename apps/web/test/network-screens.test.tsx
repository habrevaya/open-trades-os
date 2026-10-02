import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sharing, Roster, Rollup } from "../src/app/(app)/settings/network/NetworkView";
import { NAV } from "../src/lib/nav";

const view = {
  networkId: "n1", networkName: "Acme Group", networkKind: "franchise",
  memberCode: "TX-04", isOperator: false,
  sharing: [{
    aggregate: "job_counts" as const, grantedAt: "2026-04-01T00:00:00.000Z",
    description: "How many jobs you completed each month. No customers, no addresses, no amounts.",
  }],
  notSharing: [{
    aggregate: "gl_summary" as const,
    description: "Your ledger totals by account class each month.",
  }],
};

/** M01's NETWORKS ON A SCREEN: THE CONSENT, WHICH IS THE FEATURE */
describe("the group", () => {
  it("lists what is shared and what is not in one list", () => {
    /**
     * A screen that only lists what is on is a screen of facts, and this has to
     * be a screen of choices: somebody deciding whether to let a franchisor see
     * their ledger totals needs to see that they currently do not.
     */
    const html = renderToStaticMarkup(<Sharing view={view} />);
    expect(html).toContain("Job counts");
    expect(html).toContain("Shared");
    /**
     * "Ledger totals by class", not "Gl summary". On a screen whose whole job is
     * informed consent, a label that looks like a variable name is what makes
     * somebody click away without deciding.
     */
    expect(html).toContain("Ledger totals by class");
    expect(html).toContain("Not shared");
    /** The service's own words, because the description is the whole decision. */
    expect(html).toContain("No customers, no addresses, no amounts.");
    expect(html).toContain("Agreed 2026-04-01");
  });

  it("offers the opposite action on each row", () => {
    const html = renderToStaticMarkup(<Sharing
      view={view}
      control={(aggregate, sharing) => <button>{sharing ? "stop" : "start"} {aggregate}</button>}
    />);
    expect(html).toContain("stop job_counts");
    expect(html).toContain("start gl_summary");
  });

  it("shows a member sharing nothing rather than hiding it", () => {
    /**
     * The point of the roster. A list of only the sharing members makes the
     * missing numbers look like zeros, and that is the difference between
     * chasing a franchisee and writing off a market.
     */
    const html = renderToStaticMarkup(<Roster members={[
      { organizationId: "o1", name: "Acme Austin", memberCode: "TX-04", suspended: false,
        aggregates: ["job_counts", "revenue_summary"] },
      { organizationId: "o2", name: "Acme Dallas", memberCode: "TX-09", suspended: false,
        aggregates: [] },
      { organizationId: "o3", name: "Acme Waco", memberCode: null, suspended: true,
        aggregates: [] },
    ]} />);
    expect(html).toContain("Acme Dallas");
    expect(html).toContain("Nothing yet");
    /** And a suspended member is marked rather than dropped. */
    expect(html).toContain("Acme Waco");
    expect(html).toContain("Suspended");
  });

  it("formats a total as money and a count as a count", () => {
    /**
     * `invoiced` and `invoices` differ by one word. Rendering the second as
     * currency would make eleven invoices read as eleven dollars, which is the
     * kind of wrong a franchisor notices and then stops trusting the screen.
     */
    const html = renderToStaticMarkup(<Rollup
      names={new Map([["o1", "Acme Austin"]])}
      rows={[
        { organizationId: "o1", memberCode: "TX-04", period: "2026-06", metric: "invoiced", value: "48200.0000" },
        { organizationId: "o1", memberCode: "TX-04", period: "2026-06", metric: "invoices", value: "11" },
      ]}
    />);
    expect(html).toContain("Acme Austin");
    expect(html).toContain("$48,200.00");
    expect(html).toContain(">11<");
  });

  it("explains an empty roll up as a missing consent rather than a quiet month", () => {
    const html = renderToStaticMarkup(<Rollup rows={[]} names={new Map()} />);
    expect(html).toContain("has not agreed");
  });

  it("is a child of Settings", () => {
    const settings = NAV.flatMap((g) => g.items).find((i) => i.href === "/settings");
    expect(settings?.children?.map((c) => c.href)).toContain("/settings/network");
  });
});
