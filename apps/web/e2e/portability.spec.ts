import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { openCopy } from "@opentradesos/api/portability";
import { test, expect, run } from "./fixtures";

/**
 * TAKING A COMPANY OUT AND CHECKING IT BACK IN, ON THE SCREENS
 *
 * The demo company downloaded as the zip of spreadsheets, opened as a restore
 * would open it, and then checked into a new, empty company the way an owner
 * moving a company would: from setup, choosing the file, pressing Check. The
 * check is the restore rolled back, so the screen it lands on says what a
 * restore would do and the new company is still empty afterwards.
 */

const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

async function downloadArchive(owner: Page): Promise<{ folder: string; path: string; body: Buffer }> {
  const response = await owner.request.get("/settings/export/archive");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/zip");
  expect(response.headers()["content-disposition"]).toMatch(/opentradesos-export-\d{4}-\d{2}-\d{2}\.zip/);
  const body = await response.body();
  const folder = await mkdtemp(join(tmpdir(), "ots-e2e-copy-"));
  const path = join(folder, "ridgeline.zip");
  await writeFile(path, body);
  return { folder, path, body };
}

test("Take a copy as spreadsheets: a zip with a CSV per table, the files, a README and the counts", async ({ owner }) => {
  await owner.goto("/settings/export");
  await expect(owner.getByRole("link", { name: "Download as spreadsheets" })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Download as one data file" })).toBeVisible();

  const { folder, path, body } = await downloadArchive(owner);
  try {
    expect(body.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    const copy = await openCopy(path);
    try {
      expect(copy.format).toBe("archive");
      expect(copy.complete).not.toBeNull();
      expect(copy.manifest.company["name"]).toBe("Ridgeline Mechanical");
      expect(copy.manifest.people.map((p) => p.email)).toContain("owner@ridgeline.example");
      const customers = copy.manifest.tables.find((t) => t.table === "customer")!;
      let rows = 0;
      for await (const batch of copy.rows("customer")) rows += batch.rows.length;
      expect(rows).toBe(customers.rows);
      expect(await copy.columnsOf("customer")).toContain("name");
    } finally {
      await copy.close();
    }
    expect(body.includes(Buffer.from("README.md"))).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("Restore a copy: a new, empty company checks the copy and nothing is written", async ({ owner, browser, baseURL, errors }) => {
  const { folder, path } = await downloadArchive(owner);
  const db = createClient();
  /**
   * A new company for the demo's owner, empty, as whoever runs a deployment
   * makes one for somebody moving a company in. The owner of the original is
   * restoring it, so its people are linked rather than refused.
   */
  const org = crypto.randomUUID();
  const token = randomBytes(32).toString("base64url");
  try {
    await db.execute(sql`insert into public.organization (id, name, slug) values (${org}, ${`Ridgeline Restored ${run}`}, ${`ridgeline-restored-${run}`})`);
    await db.execute(sql`insert into public.membership (organization_id, user_id, role)
      select ${org}, id, 'owner' from public."user" where email = 'owner@ridgeline.example'`);
    await db.execute(sql`select app.create_session(
      (select id from public."user" where email = 'owner@ridgeline.example'),
      ${createHash("sha256").update(token).digest("hex")}, ${org}::uuid, now() + interval '1 day')`);

    const context = await browser.newContext({ baseURL: baseURL! });
    await context.addCookies([{ name: "ots_session", value: token, url: baseURL! }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${page.url()}: ${String(error)}`));

    await page.goto("/setup");
    await page.getByRole("link", { name: "Restore a copy" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Restore a copy" })).toBeVisible();
    await ready(page);

    await page.getByLabel("The copy").setInputFiles(path);
    await page.getByRole("button", { name: "Check this copy" }).click();

    await page.waitForURL(/\/setup\/restore\?run=/, { timeout: 120_000 });
    await expect(page.getByRole("heading", { name: /Checked: ridgeline\.zip/ })).toBeVisible();
    await expect(page.getByText("It would restore", { exact: true })).toBeVisible();
    await expect(page.getByText(/every record gets a new id/)).toBeVisible();
    await expect(page.getByText("You. You stay the owner.")).toBeVisible();
    await expect(page.getByRole("table", { name: "Rows by table" }).getByRole("row").filter({ hasText: "customer" }).first())
      .toBeVisible();

    // A check is the restore rolled back: the new company holds nothing yet, and can still be restored into.
    const [held] = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.customer where organization_id = ${org}`);
    expect(held!.n).toBe(0);
    await expect(page.getByRole("button", { name: "Restore it into this company" })).toBeVisible();
    await context.close();
  } finally {
    await db.execute(sql`delete from public.session where active_organization_id = ${org}`).catch(() => undefined);
    for (const table of ["restore_run", "audit_log", "membership"]) {
      await db.execute(sql`delete from ${sql.identifier(table)} where organization_id = ${org}`);
    }
    await db.execute(sql`delete from public.organization where id = ${org}`);
    await db.$close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Backups: an owner sets a bucket, and a bucket that cannot be reached is said on the screen", async ({ owner }) => {
  await owner.goto("/settings/backups");
  await expect(owner.getByRole("heading", { level: 1, name: "Backups" })).toBeVisible();
  await ready(owner);
  await owner.getByLabel("Service address").fill("http://127.0.0.1:9");
  await owner.getByLabel("Bucket", { exact: true }).fill("ridgeline-copies");
  await owner.getByLabel("Access key id").fill("AKIAEXAMPLEEXAMPLE12");
  await owner.getByLabel("Name of the secret key").fill("RIDGELINE_BACKUP_SECRET");
  await owner.getByRole("button", { name: "Save and check the bucket" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved, but the bucket did not take a test copy" })).toBeVisible();
  await expect(owner.getByRole("alert").filter({ hasText: "RIDGELINE_BACKUP_SECRET" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Take a copy now" })).toBeVisible();

  // Pasting the key itself where its name goes is refused, so it is never written down.
  await owner.getByLabel("Name of the secret key").fill("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1");
  await owner.getByRole("button", { name: "Save and check the bucket" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "looks like the secret key itself" })).toBeVisible();

  await owner.getByRole("button", { name: "Stop taking copies" }).click();
  await expect(owner.getByRole("heading", { name: "Set where copies go" })).toBeVisible();
});
