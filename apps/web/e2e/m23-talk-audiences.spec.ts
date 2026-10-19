import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A TOOLBOX TALK FOR A ROLE OR THE WHOLE COMPANY, NOT ON A HOLIDAY (M23)
 *
 * The office writes a topic, changes its words on the screen, and puts it on a
 * schedule for everybody in the field that skips the company's holidays, and
 * another for a role. What the worker does with a schedule on the day (who is
 * on the sheet, a holiday skipped, nobody to put on it) is pinned against the
 * database in the integration test; this is what a person can see and do.
 */
test("a topic's words are changed on the screen, and talks are scheduled for everybody and for a role", async ({ owner }) => {
  const title = `Heat illness ${run}`;
  const db = createClient();
  try {
    await owner.goto("/compliance/safety/topics");
    const add = owner.getByRole("region", { name: "Add a topic" });
    await add.getByLabel("Title").fill(title);
    await add.getByLabel("What the talk covers").fill("Drink water every fifteen minutes.");
    await add.getByRole("button", { name: "Add topic" }).click();
    const card = owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name: title }) });
    await expect(card).toContainText("Drink water every fifteen minutes.");

    await card.getByText("Change the words").click();
    await card.getByLabel("What the talk covers").fill("Drink water every fifteen minutes. Rest in the shade when it is over 95.");
    await card.getByRole("button", { name: "Save the new words" }).click();
    await expect(card.getByRole("status").filter({ hasText: "Talks already held keep the words they were held with." })).toBeVisible();
    await owner.reload();
    await expect(owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name: title }) }))
      .toContainText("Rest in the shade when it is over 95.");

    await owner.goto("/compliance/safety/schedules");
    const form = owner.getByRole("region", { name: "Put a talk on a schedule" });
    await form.getByLabel("Topic").selectOption({ label: title });
    await form.getByLabel("For").selectOption({ label: "Everybody in the field" });
    await form.getByLabel("How often").selectOption("weekly");
    await form.getByRole("checkbox", { name: /Skip the days the company is closed/ }).check();
    await form.getByRole("button", { name: "Put it on the schedule" }).click();
    const table = owner.getByRole("table", { name: "Talks on a schedule" });
    const everybody = table.getByRole("row").filter({ hasText: title });
    await expect(everybody).toContainText("Everybody");
    await expect(everybody).toContainText("Every Monday, not on a holiday, at 07:00");

    await form.getByLabel("Topic").selectOption({ label: title });
    await form.getByLabel("For").selectOption({ label: "Everybody with the Technician role" });
    await form.getByLabel("How often").selectOption("weekly");
    await form.getByRole("button", { name: "Put it on the schedule" }).click();
    await expect(table.getByRole("row").filter({ hasText: title }).filter({ hasText: "Everybody with the Technician role" }))
      .toContainText("Every Monday, at 07:00");

    // The API says the same: who it is for, and whether it skips holidays.
    const read = await owner.request.get("/api/v1/safety/schedules");
    const schedules = ((await read.json()) as { schedules: { topicTitle: string; audience: string; skipHolidays: boolean }[] }).schedules
      .filter((s) => s.topicTitle === title);
    expect(schedules.map((s) => `${s.audience}:${s.skipHolidays}`).sort()).toEqual(["company:true", "role:false"]);
  } finally {
    await db.execute(sql`delete from public.safety_talk_schedule where topic_id in (select id from public.safety_topic where title = ${title})`);
    await db.execute(sql`delete from public.safety_topic where title = ${title}`);
    await db.$close();
  }
});
