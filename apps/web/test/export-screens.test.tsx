import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Tables, Outside } from "../src/app/(app)/settings/export/ExportView";
import { NAV } from "../src/lib/nav";

const manifest = {
  organizationId: "org1",
  generatedAt: "2026-10-02T09:00:00.000Z",
  totalRows: 14_812,
  tables: [
    { table: "customer", rows: 14_800, key: ["id"], redacted: [] },
    {
      table: "integration_connection", rows: 12, key: ["id"],
      redacted: [{ column: "webhook_secret", reason: "A live signing secret." }],
    },
    { table: "rental", rows: 0, key: ["id"], redacted: [] },
    { table: "invoice_line", rows: 0, key: ["invoice_id", "sequence"], redacted: [] },
  ],
  outsideTheTenant: [
    { table: "credential", reason: "Password hashes. Outside the tenant and unreachable." },
  ],
};

/** M30 ON A SCREEN: WHAT IS IN THE FILE, BEFORE ANYBODY DOWNLOADS IT */
describe("taking a copy", () => {
  it("counts the rows, which is what makes an export checkable", () => {
    /**
     * Somebody who pulls 14,812 customers and had 14,900 has a problem they can
     * see. Without the count a download is a file and a hope, which is the
     * complaint the comparison pages make about every incumbent's export.
     */
    const html = renderToStaticMarkup(<Tables manifest={manifest} />);
    expect(html).toContain("14,800");
  });

  it("shows an empty table rather than leaving it out", () => {
    /**
     * An owner comparing this against their old system needs to know that
     * `rental` is empty rather than missing. A list of only the non-empty
     * tables cannot tell them apart.
     */
    const html = renderToStaticMarkup(<Tables manifest={manifest} />);
    expect(html).toContain("rental");
    expect(html).toContain(">0<");
  });

  it("names the composite key, because that is what pagination walks", () => {
    const html = renderToStaticMarkup(<Tables manifest={manifest} />);
    expect(html).toContain("invoice_id, sequence");
  });

  it("says which column is held back and why, rather than dropping it quietly", () => {
    /**
     * An export carrying a live token is a breach in a file. One that silently
     * drops it is a false claim of completeness. Naming it with a reason is the
     * only option that is neither.
     */
    const html = renderToStaticMarkup(<Tables manifest={manifest} />);
    expect(html).toContain("webhook_secret");
    expect(html).toContain("A live signing secret.");
    /** And a table holding nothing back says so rather than showing a blank. */
    expect(html).toContain("Nothing");
  });

  it("names what is outside the company so the absence is a statement", () => {
    const html = renderToStaticMarkup(<Outside manifest={manifest} />);
    expect(html).toContain("credential");
    expect(html).toContain("Password hashes.");
  });

  it("is a child of Settings and the download sits under it", () => {
    const settings = NAV.flatMap((g) => g.items).find((i) => i.href === "/settings");
    expect(settings?.children?.map((c) => c.href)).toContain("/settings/export");
  });
});
