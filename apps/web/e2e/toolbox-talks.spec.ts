import type { Locator, Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/**
 * TOOLBOX TALKS FROM THE COMPANY'S OWN LIBRARY
 *
 * The office writes a topic into its library (which starts empty), puts it on
 * a schedule for a technician, and records today's talk from the library with
 * that technician on the sheet. The office sees the technician has not signed;
 * the technician signs on their own day; the office sees nobody left to chase.
 * Every step is a screen.
 */

/** A finger's worth of strokes on the pad, until the pad has them, then Sign. */
async function sign(page: Page, pad: Locator, button: Locator) {
  await expect(async () => {
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 3, box.y + 20, { steps: 8 });
    await page.mouse.move(box.x + (2 * box.width) / 3, box.y + box.height - 20, { steps: 8 });
    await page.mouse.up();
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await button.click();
}

test("a topic from the library is scheduled, held, and signed from My day while the office watches who has not", async ({ owner, tech }) => {
  const title = `Ladder footing ${run}`;

  await owner.goto("/compliance/safety/topics");
  const add = owner.getByRole("region", { name: "Add a topic" });
  await add.getByLabel("Title").fill(title);
  await add.getByLabel("What the talk covers").fill("Foot the ladder on firm ground. Three points of contact. One person per ladder.");
  await add.getByRole("button", { name: "Add topic" }).click();
  await expect(owner.getByRole("heading", { name: title })).toBeVisible();

  await owner.goto("/compliance/safety/schedules");
  const schedule = owner.getByRole("region", { name: "Put a talk on a schedule" });
  await schedule.getByLabel("Topic").selectOption({ label: title });
  await schedule.getByLabel("For").selectOption({ label: "Ray Ortiz" });
  await schedule.getByLabel("How often").selectOption("weekly");
  await schedule.getByRole("button", { name: "Put it on the schedule" }).click();
  const row = owner.getByRole("table", { name: "Talks on a schedule" }).getByRole("row").filter({ hasText: title });
  await expect(row).toContainText("Ray Ortiz");
  await expect(row).toContainText("Every Monday, at 07:00");

  // Today's talk, recorded from the library with Ray on the sheet, held a minute ago.
  await owner.goto("/compliance/safety");
  await owner.getByLabel("From your topics (optional)").selectOption({ label: title });
  const ago = new Date(Date.now() - 5 * 60_000);
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(ago).reduce<Record<string, string>>((all, p) => ({ ...all, [p.type]: p.value }), {});
  await owner.getByLabel("When").fill(`${local["year"]}-${local["month"]}-${local["day"]}T${local["hour"]}:${local["minute"]}`);
  await owner.getByRole("checkbox", { name: "Ray Ortiz" }).check();
  await owner.getByRole("button", { name: "Record the talk" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Recorded." })).toBeVisible();
  const waiting = owner.getByRole("region", { name: "Not signed yet" });
  await expect(waiting.getByRole("listitem").filter({ hasText: title })).toContainText("Ray Ortiz");

  // Ray signs on his own day, reading the library's words first.
  await tech.goto("/my-day");
  const card = tech.getByRole("listitem").filter({ hasText: title });
  await expect(card).toContainText("Foot the ladder on firm ground.");
  await sign(tech, card.getByLabel(`Sign for ${title}`), card.getByRole("button", { name: "Sign", exact: true }));
  await expect(card.getByRole("status")).toContainText("Signed. Thank you.");

  await owner.reload();
  await expect(owner.getByRole("region", { name: "Not signed yet" }).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
});
