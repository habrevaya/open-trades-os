import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { appRequestReminders } from "@opentradesos/api/services";
import { test, expect, run } from "./fixtures";

/**
 * AN APP REQUEST NOBODY HAS ANSWERED IS CHASED ONCE
 *
 * The owner chooses on Applications how many days a waiting request goes
 * before the people who could approve it are told again. An app asks; the
 * request has waited that long; the worker's pass tells the owner once more,
 * and the notice is on their notices page. A second pass tells nobody.
 */

const COMPANY = "ridgeline";

async function askedDaysAgo(id: string, days: number) {
  const db = createClient();
  try {
    await db.execute(sql`
      update public.connected_app
         set created_at = created_at - (${days}::int * interval '1 day'),
             request_expires_at = now() + interval '3 days'
       where id = ${id}::uuid`);
  } finally {
    await db.$close();
  }
}

async function workerPass() {
  const db = createClient();
  try {
    return await appRequestReminders.reminderPass(db, { force: true });
  } finally {
    await db.$close();
  }
}

test("the owner sets the reminder, a waiting request is chased once, and the notice is on their page", async ({ owner, stranger }) => {
  test.setTimeout(120_000);
  const name = `Slow Partner ${run}`;
  const region = owner.getByRole("region", { name: "Reminders" });

  try {
    await owner.goto("/settings/apps");
    /** Three until the company says otherwise. */
    await expect(region.getByLabel("Days before a reminder")).toHaveValue("3");
    await region.getByLabel("Days before a reminder").fill("1");
    await region.getByRole("button", { name: "Save" }).click();
    await expect(region.getByText("Whoever can approve is reminded once, 1 day after an application asks.")).toBeVisible();
    await owner.reload();
    await expect(region.getByLabel("Days before a reminder")).toHaveValue("1");

    const asked = await stranger.request.post("/api/v1/public/app-requests", {
      data: { company: COMPANY, name, permissions: ["customer:read"], scopes: { customer: "all" } },
    });
    expect(asked.status()).toBe(201);
    const { id } = await asked.json() as { id: string };

    /** Asked today: not yet. Two days on: told once more, and not a third time. */
    await workerPass();
    await owner.goto("/notices");
    const list = owner.getByRole("list", { name: "Your notices" });
    await expect(list.getByRole("link").filter({ hasText: `${name} is asking to connect` })).toBeVisible();
    await expect(list.getByRole("link").filter({ hasText: `${name} is still waiting for an answer` })).toHaveCount(0);

    await askedDaysAgo(id, 2);
    await workerPass();
    await workerPass();
    await owner.goto("/notices");
    const reminder = list.getByRole("link").filter({ hasText: `${name} is still waiting for an answer` });
    await expect(reminder).toHaveCount(1);
    await expect(reminder).toContainText("Nothing is given until somebody says yes.");
    await reminder.click();
    await expect(owner).toHaveURL(new RegExp(`/settings/apps/requests/${id}$`));
  } finally {
    /** Back to the default, so no other spec is surprised. */
    await owner.goto("/settings/apps");
    await region.getByLabel("Days before a reminder").fill("3");
    await region.getByRole("button", { name: "Save" }).click();
    await expect(region.getByText("reminded once, 3 days after an application asks.")).toBeVisible();
  }
});
