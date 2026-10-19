import { eq, sql } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

test.afterAll(async () => { await quietHoursAway(false); });

/**
 * The company's quiet hours, moved to an hour twelve hours away (or taken off
 * again), so the clock cannot decide the test: a send to the people held back
 * is refused whole inside quiet hours, which by default run from nine at night
 * to eight in the morning. The same helper as the portal chat specs.
 */
async function quietHoursAway(on: boolean): Promise<void> {
  const db = createClient();
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date())) % 24;
    const window = JSON.stringify({ quietHours: { startHour: (hour + 12) % 24, endHour: (hour + 13) % 24 } });
    await db.update(schema.organization).set({
      settings: on
        ? sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${window}::jsonb`
        : sql`coalesce(${schema.organization.settings}, '{}'::jsonb) - 'quietHours'`,
    }).where(eq(schema.organization.slug, "ridgeline"));
  } finally {
    await db.$close();
  }
}

/**
 * A TEST THAT HOLDS PART OF THE LIST BACK, AND THE WINNER SENT TO IT, THROUGH THE SCREENS
 *
 * The office writes two versions and holds most of the list back. The send
 * writes the held back people and sends them nothing; the results say nothing
 * won and offer version A, by name and with the number of people; pressing it
 * sends version A to them, checking consent again for each, and the page then
 * says what went and why. The seeded company has no texting consent on these
 * customers, so every one of them is refused at send time, which is the check
 * this spec can see. The split, the judgement and a winner that did win are in
 * packages/api/test/campaign-hold-back.integration.test.ts.
 */
test("Campaigns: part of the list is held back from a test, and a person sends it version A when nothing won", async ({ owner }) => {
  await quietHoursAway(true);
  /** Four customers in a postcode of this run's own, so most of them are held back by the hash. */
  const zip = `9${String(Date.now() % 10_000).padStart(4, "0")}`;
  for (let i = 1; i <= 4; i += 1) {
    await newCustomer(owner, {
      name: `Held ${run} ${i}`,
      phone: `+1737${String((Date.now() + i) % 10_000_000).padStart(7, "0")}`,
      address: { street: `${i} Hold Lane`, city: "Austin", state: "TX", zip },
    });
  }

  await owner.goto("/marketing/campaigns");
  const form = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save as a draft" }) });
  const name = `Held back ${run}`;
  const fill = async (holdBack: string) => {
    await form.getByLabel("Name").fill(name);
    await form.getByRole("checkbox").and(form.locator('[value="postal_code_in"]')).check();
    await form.getByLabel("Postcodes, comma separated").fill(zip);
    await form.getByRole("textbox", { name: "Message" }).fill("Comfort Co: $89 tune ups this month. Reply STOP to opt out.");
    await form.getByRole("textbox", { name: "Version B words" }).fill("Comfort Co: tune ups, $79 until Friday. Reply STOP to opt out.");
    await form.getByLabel("Hold back part of the list for the winner, in percent (blank holds nobody back)").fill(holdBack);
  };

  // Out of bounds is refused in words.
  await fill("99");
  await form.getByRole("button", { name: "Save as a draft" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "Hold back between 5% and 95% of the list" })).toBeVisible();

  await fill("95");
  await form.getByRole("button", { name: "Save as a draft" }).click();
  const row = () => owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name });
  await expect(row()).toContainText("two versions");

  // The preview says who is held back and that nothing goes to them by itself.
  await row().getByRole("link", { name: "Who it reaches" }).click();
  const audience = owner.locator("section").filter({ hasText: "Who it reaches" });
  await expect(audience).toContainText("95% of the list is held back.");
  await expect(audience).toContainText("Nothing goes to them by itself.");

  // The send writes the held back people and sends them nothing.
  await row().getByRole("button", { name: "Send a batch" }).click();
  await expect(row()).toContainText("sent");
  await expect(row()).toContainText("held back for the winner");

  // Nothing won, the page says so, and offers version A by name.
  await row().getByRole("link", { name: "Compare the versions" }).click();
  const rest = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "The rest of the list (95% held back)" }) }).last();
  await expect(rest).toContainText("No version won, so there is no winner to send.");
  const button = rest.getByRole("button", { name: /^Send version A to the \d+ (person|people) held back$/ });
  await expect(button).toBeVisible();
  await expect(rest.getByRole("button", { name: /Send version B/ })).toHaveCount(0);

  // Pressed, it goes, and the page says what went and why. Nothing more is offered.
  await button.click();
  const after = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "The rest of the list (95% held back)" }) }).last();
  await expect(after).toContainText("Version A went to the people held back, because no version won");
  await expect(after).toContainText("0 queued");
  await expect(after.getByRole("button")).toHaveCount(0);

  // Consent was checked again for each of them: none of these customers agreed to texts.
  await owner.goto("/marketing/campaigns");
  await row().getByRole("link", { name: "Who it went to" }).click();
  const recipients = owner.getByRole("table", { name: "Recipients" });
  await expect(recipients.getByRole("row").filter({ hasText: "A, later" }).first()).toContainText("Not sent:");
});
