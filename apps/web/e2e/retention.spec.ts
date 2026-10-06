import { test, expect, run } from "./fixtures";

/**
 * KEEPING RECORDS: A RULE WRITTEN ON THE SCREEN, AND A HOLD FROM THE RECORD
 *
 * The owner writes a retention rule of the company's own, which arrives with
 * purging off like every seeded one, and puts a hold on an incident report
 * from the report's own page, then lifts it. Reporting the incident is done
 * through the API as the signed in owner, because the report form is not what
 * is under test here.
 */
test("a retention rule is written on the screen, and an incident is held and released from its own page", async ({ owner }) => {
  const name = `Our drain photographs ${run}`;
  await owner.goto("/compliance/retention");
  const form = owner.getByRole("region", { name: "Write a rule" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Kind of record").selectOption("photo");
  await form.getByLabel("Only this kind (optional)").fill("drain");
  await form.getByLabel("Kept for, in months").fill("36");
  await form.getByLabel("Counted from").selectOption("work_completed");
  await form.getByRole("button", { name: "Write rule" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Written: Kept 3 years from when the work was finished." })).toBeVisible();
  const rule = owner.getByRole("region", { name: `Rule: ${name}` });
  await expect(rule).toContainText("Purging off");
  await expect(rule).toContainText("Kept 3 years from when the work was finished.");

  const reported = await owner.request.post("/api/v1/safety/incidents", {
    data: { kind: "near_miss", occurredAt: new Date().toISOString(), description: `Ladder slipped ${run}` },
  });
  expect(reported.ok()).toBe(true);
  const { id } = await reported.json() as { id: string };

  await owner.goto(`/compliance/incidents/${id}`);
  const keep = owner.getByRole("region", { name: "Keep this report" });
  await expect(keep).toContainText("Not on hold");
  await keep.getByLabel("Why this report is kept").fill(`The Ruiz claim ${run}`);
  await keep.getByRole("button", { name: "Keep it" }).click();
  await expect(keep).toContainText(`On hold: The Ruiz claim ${run}`);

  await owner.goto("/compliance/retention");
  await expect(owner.getByRole("table", { name: "Holds" })).toContainText(`The Ruiz claim ${run}`);

  await owner.goto(`/compliance/incidents/${id}`);
  await keep.getByRole("button", { name: "Lift the hold" }).click();
  await expect(keep).toContainText("Not on hold");
});
