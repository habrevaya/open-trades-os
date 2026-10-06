import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";
import { test, expect } from "./fixtures";

/**
 * THE PUBLIC DEMO, CLICKED THROUGH, AND NOTHING KEPT
 *
 * A stranger follows the website's link to /demo, lands on the dispatch
 * board signed in as the demo company's read only user, and opens every
 * screen the navigation offers them plus a record of each kind. Then the
 * database is counted, table by table, against the count taken before they
 * arrived: the only rows allowed to be new are their session and the rate
 * limit's note of their visit. docs/self-hosting/demo.md.
 */

/** Every table in public, and how many rows it has right now. */
async function rowCounts(): Promise<Map<string, number>> {
  const db = createClient();
  try {
    const rows = await db.execute<{ table_name: string; n: string }>(sql`
      select table_name,
             (xpath('/row/n/text()',
               query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text as n
        from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`);
    return new Map(rows.map((r) => [r.table_name, Number(r.n)]));
  } finally {
    await db.$close();
  }
}

/** What a visit is allowed to add: the visitor's own session, and the rate limit's row. */
const EXPECTED_TO_GROW = new Set(["session", "demo_visit"]);

test("a stranger opens /demo, clicks through the main screens and the API, and nothing is written", async ({ stranger }) => {
  const before = await rowCounts();

  await stranger.goto("/demo");
  await expect(stranger).toHaveURL(/\/schedule/);
  const banner = stranger.getByRole("note", { name: "Demo" });
  await expect(banner).toContainText("Nothing you do here is saved.");
  await expect(banner.getByRole("link", { name: "Back to the website" })).toBeVisible();

  // Every screen in the navigation, as the read only user sees it.
  const rail = stranger.getByRole("complementary").getByRole("navigation");
  const hrefs = [...new Set(await rail.getByRole("link").evaluateAll(
    (links) => links.map((a) => (a as HTMLAnchorElement).getAttribute("href")!),
  ))];
  expect(hrefs.length).toBeGreaterThanOrEqual(8);
  expect(hrefs).toEqual(expect.arrayContaining(["/schedule", "/jobs", "/customers", "/invoices"]));
  // The read only role has no settings, payroll or automations to open.
  expect(hrefs).not.toContain("/settings");
  expect(hrefs).not.toContain("/payroll");

  for (const href of hrefs) {
    const response = await stranger.goto(href);
    expect(response?.status(), href).toBeLessThan(400);
    await expect(stranger.getByRole("note", { name: "Demo" }), href).toBeVisible();
  }

  // One record of each kind, opened from its list the way somebody would.
  for (const list of ["/customers", "/jobs", "/estimates", "/invoices"]) {
    await stranger.goto(list);
    const record = new RegExp(`^${list}/[0-9a-f-]{36}$`);
    const href = (await stranger.locator("main a[href]").evaluateAll(
      (links) => links.map((a) => (a as HTMLAnchorElement).getAttribute("href")!),
    )).find((h) => record.test(h));
    expect(href, `a record on ${list}`).toBeTruthy();
    await stranger.locator(`main a[href="${href}"]`).first().click();
    await expect(stranger, list).toHaveURL(new RegExp(`${list}/[0-9a-f-]{36}`));
    await expect(stranger.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(stranger.getByRole("note", { name: "Demo" })).toBeVisible();
  }

  // Nothing on a record offers to change it: the controls follow permission.
  await expect(stranger.getByRole("button", { name: /^(Save|Send|Delete|Void|Record payment)/ })).toHaveCount(0);

  // And the API refuses a write outright, whatever the screen would have shown.
  const write = await stranger.request.post("/api/v1/customers", {
    data: { type: "residential", name: "Somebody typed this" },
  });
  expect(write.status()).toBe(403);
  expect((await write.json()).code).toBe("demo_read_only");
  const read = await stranger.request.get("/api/v1/customers");
  expect(read.status()).toBe(200);

  const after = await rowCounts();
  const changed = [...after].filter(([table, n]) => !EXPECTED_TO_GROW.has(table) && before.get(table) !== n)
    .map(([table, n]) => `${table}: ${before.get(table)} -> ${n}`);
  expect(changed).toEqual([]);
});
