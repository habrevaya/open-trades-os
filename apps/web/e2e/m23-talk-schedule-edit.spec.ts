import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * CHANGING A SCHEDULED TOOLBOX TALK (M23)
 *
 * A talk is put on a schedule for everybody, and then changed on its own page:
 * another topic, another audience, an earlier time and holidays skipped. The
 * list says the new things. What a talk already raised keeps, and what the
 * worker does on the day, is pinned against the database in the integration
 * test; this is what a person can see and do.
 */
test("a scheduled talk is changed on its page and the list says the new topic, people, time and holidays", async ({ owner }) => {
  const heat = `Heat illness ${run}`;
  const ladders = `Ladder safety ${run}`;
  const db = createClient();
  try {
    for (const [title, words] of [[heat, "Drink water every fifteen minutes."], [ladders, "Three points of contact."]] as const) {
      await owner.goto("/compliance/safety/topics");
      const add = owner.getByRole("region", { name: "Add a topic" });
      await add.getByLabel("Title").fill(title);
      await add.getByLabel("What the talk covers").fill(words);
      await add.getByRole("button", { name: "Add topic" }).click();
      await expect(owner.getByRole("heading", { name: title })).toBeVisible();
    }

    await owner.goto("/compliance/safety/schedules");
    const form = owner.getByRole("region", { name: "Put a talk on a schedule" });
    await form.getByLabel("Topic").selectOption({ label: heat });
    await form.getByLabel("For").selectOption({ label: "Everybody in the field" });
    await form.getByLabel("How often").selectOption("weekly");
    await form.getByRole("button", { name: "Put it on the schedule" }).click();
    const table = owner.getByRole("table", { name: "Talks on a schedule" });
    await expect(table.getByRole("row").filter({ hasText: heat })).toContainText("Every Monday, at 07:00");

    await table.getByRole("link", { name: `Change ${heat}` }).click();
    await expect(owner.getByRole("heading", { name: `Change: ${heat}` })).toBeVisible();
    await owner.getByLabel("Topic").selectOption({ label: ladders });
    await owner.getByLabel("For").selectOption({ label: "Everybody with the Technician role" });
    await owner.getByLabel("At", { exact: true }).fill("06:30");
    await owner.getByLabel("Where (optional)").fill("The yard");
    await owner.getByRole("checkbox", { name: /Skip the days the company is closed/ }).check();
    await owner.getByRole("button", { name: "Save changes" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Talks already raised keep what they were given." })).toBeVisible();

    await owner.goto("/compliance/safety/schedules");
    const row = owner.getByRole("table", { name: "Talks on a schedule" }).getByRole("row").filter({ hasText: ladders });
    await expect(row).toContainText("Everybody with the Technician role");
    await expect(row).toContainText("Every Monday, not on a holiday, at 06:30, The yard");
    await expect(owner.getByRole("table", { name: "Talks on a schedule" }).getByRole("row").filter({ hasText: heat })).toHaveCount(0);

    // The page opens with what the schedule has now.
    await row.getByRole("link", { name: `Change ${ladders}` }).click();
    await expect(owner.getByLabel("At", { exact: true })).toHaveValue("06:30");
    await expect(owner.getByLabel("Where (optional)")).toHaveValue("The yard");
    await expect(owner.getByRole("checkbox", { name: /Skip the days the company is closed/ })).toBeChecked();
  } finally {
    await db.execute(sql`delete from public.safety_talk_schedule where topic_id in (select id from public.safety_topic where title in (${heat}, ${ladders}))`);
    await db.execute(sql`delete from public.safety_topic where title in (${heat}, ${ladders})`);
    await db.$close();
  }
});
