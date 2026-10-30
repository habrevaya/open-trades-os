import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * A RECURRING TASK ON SEVERAL DAYS, AND LOOPS IN WHO ANSWERS TO WHOM
 *
 * Every third week on Monday and Thursday is one recurring task, ticked on the
 * same boxes as "the days I tick", changed to one day and back from its own
 * page. And the reporting lines page names a loop already in the data in
 * words, and changes nothing.
 */
test("a task every third week is ticked on two days, then changed to one", async ({ owner }) => {
  const title = `Swap the dumpster ${run}`;
  await owner.goto("/tasks/recurring");
  await owner.getByLabel("What needs doing").fill(title);
  await owner.getByLabel("How often").selectOption("every_n_weeks");
  await owner.getByLabel(/^How many weeks apart/).fill("3");
  const days = owner.getByRole("group", { name: /^Which days/ });
  await days.getByLabel("Monday").check();
  await days.getByLabel("Thursday").check();
  await ready(owner);
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  const row = owner.getByRole("row", { name: new RegExp(title) });
  await expect(row).toContainText("Every 3 weeks on Monday and Thursday");

  await row.getByRole("link", { name: `Change ${title}` }).click();
  const ticked = owner.getByRole("group", { name: /^Which days/ });
  await expect(ticked.getByLabel("Monday")).toBeChecked();
  await expect(ticked.getByLabel("Thursday")).toBeChecked();
  await expect(ticked.getByLabel("Tuesday")).not.toBeChecked();

  // Back to one day: untick both and choose the day of the week.
  await ticked.getByLabel("Monday").uncheck();
  await ticked.getByLabel("Thursday").uncheck();
  await owner.getByLabel(/^Day of the week/).selectOption("3");
  await ready(owner);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "It applies from the next time it comes round" })).toBeVisible();
  await owner.goto("/tasks/recurring");
  await expect(owner.getByRole("row", { name: new RegExp(title) })).toContainText("Every 3 weeks on Wednesday");

  // And a single ticked day is the day it is.
  await owner.getByRole("row", { name: new RegExp(title) }).getByRole("link", { name: `Change ${title}` }).click();
  await owner.getByRole("group", { name: /^Which days/ }).getByLabel("Friday").check();
  await ready(owner);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "It applies from the next time it comes round" })).toBeVisible();
  await owner.goto("/tasks/recurring");
  await expect(owner.getByRole("row", { name: new RegExp(title) })).toContainText("Every 3 weeks on Friday");
});

test("the reporting lines page names a loop in the data, in words, and mends nothing", async ({ owner }) => {
  const db = createClient();
  const org = (await db.select({ id: schema.organization.id }).from(schema.organization)
    .where(eq(schema.organization.slug, "ridgeline")).limit(1))[0]!.id;
  const members = await db.select({ userId: schema.membership.userId, to: schema.membership.reportsToUserId }).from(schema.membership)
    .where(and(eq(schema.membership.organizationId, org), eq(schema.membership.active, true)));
  const [one, two] = members;
  expect(two, "the seeded company has at least two people").toBeTruthy();
  const set = (userId: string, to: string | null) => db.update(schema.membership).set({ reportsToUserId: to })
    .where(and(eq(schema.membership.organizationId, org), eq(schema.membership.userId, userId)));

  try {
    await owner.goto("/tasks/escalation");
    const loops = owner.getByLabel("Loops");
    // The seed has no loop; if another spec left lines, they are not loops.
    await expect(loops).toContainText("No loops.");

    await set(one!.userId, two!.userId);
    await set(two!.userId, one!.userId);
    await owner.reload();
    await expect(owner.getByLabel("Loops")).toContainText("There is a loop in who answers to whom.");
    await expect(owner.getByLabel("Loops")).toContainText(/reports to .+ and .+ reports to /);
    await expect(owner.getByLabel("Loops")).toContainText("Nothing is changed for you.");
    // Mended nothing: both lines are still there.
    const after = await db.select({ userId: schema.membership.userId, to: schema.membership.reportsToUserId })
      .from(schema.membership).where(eq(schema.membership.organizationId, org));
    expect(after.find((m) => m.userId === one!.userId)!.to).toBe(two!.userId);
    expect(after.find((m) => m.userId === two!.userId)!.to).toBe(one!.userId);
  } finally {
    // Back to what the seed left.
    await set(one!.userId, one!.to);
    await set(two!.userId, two!.to);
    await db.$close();
  }
});
