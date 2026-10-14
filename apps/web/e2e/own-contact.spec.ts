import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect } from "./fixtures";

/**
 * A PERSON KEEPS THEIR OWN ADDRESS AND PHONE NUMBER
 *
 * The technician changes theirs on My record and sees what changed; the office opens their
 * page and reads the same, with when, and has nothing to edit it with.
 */

async function forgetContacts() {
  const db = createClient();
  try {
    await db.execute(sql`delete from public.person_contact
      where organization_id = (select id from public.organization where slug = 'ridgeline')`);
  } finally {
    await db.$close();
  }
}

test("a technician keeps their own phone and address, and the office sees what changed", async ({ owner, tech }) => {
  test.setTimeout(120_000);
  await forgetContacts();
  try {
    await tech.goto("/me");
    const reach = tech.getByRole("region", { name: "Your phone and address" });
    await expect(reach).toBeVisible();

    // A half address is refused in words, and nothing is kept.
    await reach.getByLabel("Your phone number").fill("(512) 555-0143");
    await reach.getByLabel("Street").fill("12 Oak St");
    await reach.getByRole("button", { name: "Save" }).click();
    await expect(tech.getByRole("alert").filter({ hasText: "street, the town, the state and the ZIP" })).toBeVisible();

    await reach.getByLabel("Town").fill("Austin");
    await reach.getByLabel("State (two letters)").fill("tx");
    await reach.getByLabel("ZIP code").fill("78701");
    await reach.getByRole("button", { name: "Save" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const changes = reach.getByRole("list", { name: "Changes to phone and address" });
    await expect(changes).toContainText("Phone: none to (512) 555-0143");
    await expect(changes).toContainText("Address: none to 12 Oak St, Austin, TX 78701");

    // It is there after a reload, and a move is a second line saying what it was.
    await tech.reload();
    await expect(reach.getByLabel("State (two letters)")).toHaveValue("TX");
    await reach.getByLabel("Street").fill("9 Elm Ct");
    await reach.getByLabel("Town").fill("Round Rock");
    await reach.getByLabel("ZIP code").fill("78664");
    await reach.getByRole("button", { name: "Save" }).click();
    await expect(changes).toContainText("Address: 12 Oak St, Austin, TX 78701 to 9 Elm Ct, Round Rock, TX 78664");
    await expect(changes.getByRole("listitem")).toHaveCount(2);

    // The office reads it on the person's page, with the same changes, and has no form for it.
    await owner.goto("/people");
    await owner.getByRole("link", { name: "Ray Ortiz" }).click();
    const theirs = owner.getByRole("region", { name: "Phone and address" });
    await expect(theirs).toContainText("(512) 555-0143");
    await expect(theirs).toContainText("9 Elm Ct, Round Rock, TX 78664");
    await expect(theirs.getByRole("list", { name: "Changes to phone and address" }).getByRole("listitem")).toHaveCount(2);
    await expect(theirs.getByRole("button")).toHaveCount(0);
  } finally {
    await forgetContacts();
  }
});
