import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/** The page has hydrated, so a press lands on the form React manages. */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/**
 * WHO SOMEBODY REPORTS TO, SET FROM THEIR OWN PAGE
 *
 * The person's page sets the manager the escalation screen sets, and the
 * escalation screen shows it.
 */

test("who a person reports to is set on their own page and shown on the escalation screen", async ({ owner }) => {
  const roster = await owner.request.get("/api/v1/roster");
  const active = ((await roster.json()) as { people: { membershipId: string; name: string | null; email: string; active: boolean }[] })
    .people.filter((p) => p.active);
  expect(active.length).toBeGreaterThan(1);
  const [person, manager] = active as [typeof active[number], typeof active[number]];
  const personName = person.name ?? person.email;
  const managerName = manager.name ?? manager.email;

  await owner.goto(`/people/${person.membershipId}`);
  const select = owner.getByLabel(`Manager of ${personName}`);
  await select.selectOption({ label: managerName });
  await ready(owner);
  await select.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
  const line = owner.getByTestId("reports-to");
  await expect(line.getByRole("link", { name: managerName })).toHaveAttribute("href", `/people/${manager.membershipId}`);

  await owner.goto("/tasks/escalation");
  await expect(owner.getByLabel(`Manager of ${personName}`).locator("option:checked")).toHaveText(managerName);

  // And taken off again from the same page.
  await owner.goto(`/people/${person.membershipId}`);
  await owner.getByLabel(`Manager of ${personName}`).selectOption("");
  await ready(owner);
  await owner.getByTestId("reports-to").getByRole("button", { name: "Save" }).click();
  await expect(owner.getByTestId("reports-to").getByRole("link")).toHaveCount(0);
  await expect(owner.getByTestId("reports-to")).toContainText("Nobody recorded");
});
