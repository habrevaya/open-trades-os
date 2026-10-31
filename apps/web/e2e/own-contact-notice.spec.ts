import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, companyToday } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * THE OFFICE IS TOLD WHEN A PERSON CHANGES THEIR OWN PHONE, A SECOND MAILBOX FOR
 * THEIR LICENCE EMAILS, AND "TICK EVERY CARD"
 *
 * What a person at the keyboard sees. Who is told and who is not, and which
 * address an email goes to, are pinned in the integration test.
 */
async function forget() {
  const db = createClient();
  try {
    await db.execute(sql`delete from public.person_contact
      where organization_id = (select id from public.organization where slug = 'ridgeline')`);
    await db.execute(sql`delete from public.person_second_email
      where organization_id = (select id from public.organization where slug = 'ridgeline')`);
    await db.execute(sql`delete from public.staff_notice
      where kind = 'contact_changed' and organization_id = (select id from public.organization where slug = 'ridgeline')`);
  } finally {
    await db.$close();
  }
}

test("a technician changes their phone and the owner is told that, without the number", async ({ owner, tech }) => {
  test.setTimeout(120_000);
  await forget();
  try {
    await tech.goto("/me");
    const reach = tech.getByRole("region", { name: "Your phone and address" });
    await reach.getByLabel("Your phone number").fill("(512) 555-0143");
    await ready(tech);
    await reach.getByRole("button", { name: "Save" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

    await owner.goto("/notices");
    const line = owner.getByRole("list", { name: "Your notices" }).getByRole("listitem").filter({ hasText: "Ray Ortiz added a phone number" });
    await expect(line).toBeVisible();
    await expect(line).not.toContainText("555");
    await expect(line).toContainText("A colleague changed their phone or address");
    await line.getByRole("link").first().click();
    await expect(owner).toHaveURL(/\/people\//);
    await expect(owner.getByRole("region", { name: "Phone and address" })).toContainText("(512) 555-0143");

    // The owner can switch this kind off for themselves like any other.
    await owner.goto("/me");
    await expect(owner.locator("#notices").getByRole("checkbox", { name: "A colleague changed their phone or address: in the app" })).toBeChecked();
  } finally {
    await forget();
  }
});

test("a technician keeps a second email for their own licence emails, and the office reads it", async ({ owner, tech }) => {
  test.setTimeout(120_000);
  await forget();
  try {
    await tech.goto("/me");
    const second = tech.getByRole("region", { name: "A second email for your licence emails" });
    await second.getByLabel("Second email address").fill("ray@home");
    await ready(tech);
    await second.getByRole("button", { name: "Save" }).click();
    await expect(tech.getByRole("alert").filter({ hasText: "is not an email address" })).toBeVisible();

    await second.getByLabel("Second email address").fill("ray.home@example.com");
    await second.getByRole("button", { name: "Save" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "also go to ray.home@example.com" })).toBeVisible();
    await tech.reload();
    await expect(second.getByLabel("Second email address")).toHaveValue("ray.home@example.com");

    await owner.goto("/people");
    await owner.getByRole("link", { name: "Ray Ortiz" }).click();
    await expect(owner.getByRole("region", { name: "Phone and address" })).toContainText("ray.home@example.com");
    await expect(owner.getByRole("region", { name: "Phone and address" }).getByRole("button")).toHaveCount(0);

    // An empty box takes it off.
    await second.getByLabel("Second email address").fill("");
    await second.getByRole("button", { name: "Save" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "go to the address you sign in with only" })).toBeVisible();
  } finally {
    await forget();
  }
});

test("Tick every card ticks each card that expires, and Clear the ticks takes them off", async ({ owner }) => {
  const name = `Tick Tina ${run}`;
  const kind = `Forklift ticket ${run}`;
  const db = createClient();
  const [user] = await db.execute<{ id: string }>(sql`insert into public."user" (email, name) values (${`tick-tina-${run}@e2e.test`}, ${name}) returning id`);
  const [member] = await db.execute<{ id: string; organization_id: string }>(sql`
    insert into public.membership (organization_id, user_id, role)
    select id, ${user!.id}, 'technician' from public.organization where slug = 'ridgeline' returning id, organization_id`);
  const [tech] = await db.execute<{ id: string }>(sql`insert into public.technician (organization_id, membership_id, display_name)
    values (${member!.organization_id}, ${member!.id}, ${name}) returning id`);
  const [type] = await db.execute<{ id: string }>(sql`
    insert into public.certification_type (organization_id, code, name, renewal_lead_days)
    values (${member!.organization_id}, ${`FT${run.slice(-8).toUpperCase()}`}, ${kind}, 60) returning id`);
  const [y, m, d] = companyToday().split("-").map(Number);
  const expires = new Date(Date.UTC(y!, m! - 1, d! + 200)).toISOString().slice(0, 10);
  await db.execute(sql`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on, status)
    values (${member!.organization_id}, ${tech!.id}, ${type!.id}, ${expires}, 'active')`);
  try {
    await owner.goto("/certifications");
    const bulk = owner.locator("form#bulk-renewal-days");
    const boxes = owner.locator('input[type="checkbox"][form="bulk-renewal-days"]');
    const total = await boxes.count();
    expect(total).toBeGreaterThan(0);
    await expect(owner.locator('input[type="checkbox"][form="bulk-renewal-days"]:checked')).toHaveCount(0);

    await ready(owner);
    await bulk.getByRole("button", { name: "Tick every card" }).click();
    await expect(bulk.getByRole("status")).toContainText(total === 1 ? "Ticked the 1 card." : `Ticked all ${total} cards.`);
    await expect(owner.locator('input[type="checkbox"][form="bulk-renewal-days"]:checked')).toHaveCount(total);
    await expect(owner.getByRole("checkbox", { name: `Tick ${kind} for ${name}` })).toBeChecked();

    await bulk.getByRole("button", { name: "Clear the ticks" }).click();
    await expect(bulk.getByRole("status")).toContainText("Cleared every tick.");
    await expect(owner.locator('input[type="checkbox"][form="bulk-renewal-days"]:checked')).toHaveCount(0);
  } finally {
    await db.execute(sql`delete from public.person_certification where technician_id = ${tech!.id}`);
    await db.execute(sql`delete from public.certification_type where id = ${type!.id}`);
    await db.execute(sql`delete from public.technician where id = ${tech!.id}`);
    await db.execute(sql`delete from public.membership where id = ${member!.id}`);
    await db.execute(sql`delete from public."user" where id = ${user!.id}`);
    await db.$close();
  }
});
