import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/**
 * A COMPANY WRITES ITS OWN INSPECTION PROGRAMME
 *
 * The owner starts from the plumbing trade pack's backflow test, which as
 * shipped asks for readings with no range and so cannot be filed against. The
 * copy says so, is refused until the ranges are given, and is saved as the
 * company's own with where it came from. A change publishes version 2, and
 * version 1 can still be read as it was. Stopping offering it keeps it.
 */
async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `GET ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("an owner copies a pack's programme, fixes it, saves it, and publishes a second version", async ({ owner }) => {
  const name = `Backflow test ${run}`;

  await owner.goto("/inspections/programmes");
  const packs = owner.getByRole("region", { name: "Start from a trade pack" });
  await packs.getByRole("listitem").filter({ hasText: "Backflow prevention assembly test" })
    .getByRole("link", { name: "Start from this" }).click();
  await expect(owner).toHaveURL(/\/inspections\/programmes\/new\?pack=plumbing&code=backflow-annual$/);

  // The copy says, before anything is saved, why it could not be filed as the pack ships it.
  await expect(owner.getByRole("note")).toContainText("cannot be filed against this as it stands");
  await expect(owner.getByRole("note")).toContainText("no acceptable range");

  await owner.getByLabel("Name", { exact: true }).fill(name);
  // Keep the pack's own beside it, if the company has it, so no other test loses it.
  const replace = owner.getByRole("checkbox", { name: /Use this instead of/ });
  if (await replace.count()) await replace.uncheck();

  // Saved as it is, it is refused in words.
  await owner.getByRole("button", { name: "Save the programme" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "no acceptable range" })).toBeVisible();

  const checkpoint = (n: number) => owner.getByRole("group", { name: `Checkpoint ${n}`, exact: true });
  await expect(checkpoint(2).getByLabel("Question")).toHaveValue("First check valve holds");
  for (const n of [2, 3, 4]) await checkpoint(n).getByLabel("Lowest that passes").fill("1");
  await owner.getByRole("button", { name: "Save the programme" }).click();

  await expect(owner).toHaveURL(/\/inspections\/programmes\/[0-9a-f-]{36}\?published=1$/);
  await expect(owner.getByRole("status")).toContainText("Saved as version 1.");
  await expect(owner.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(owner.getByText("Your own, copied from the Plumbing trade pack's Backflow prevention assembly test.")).toBeVisible();
  await expect(owner.getByText("Offered to technicians", { exact: true })).toBeVisible();
  const id = /programmes\/([0-9a-f-]{36})/.exec(owner.url())![1]!;

  // A change: every two years, and one more checkpoint, with what changed in words.
  await owner.getByLabel("How often, in months").fill("24");
  await owner.getByRole("button", { name: "Add a checkpoint" }).click();
  await checkpoint(8).getByLabel("Question").fill(`Test cock 4 seals ${run}`);
  await checkpoint(8).getByLabel("How serious a fail is").selectOption({ label: "Wearing out: fix within 180 days" });
  await owner.getByLabel("What changed").fill("The water company asks for test cock 4 now");
  await owner.getByRole("button", { name: "Publish version 2" }).click();

  await expect(owner).toHaveURL(new RegExp(`/inspections/programmes/${id}\\?published=2$`));
  await expect(owner.getByRole("status")).toContainText("Version 2 published.");
  const versions = owner.getByRole("region", { name: "Versions" });
  await expect(versions.getByRole("listitem").filter({ hasText: "Version 2" }))
    .toContainText("Changed the checkpoints, how often.");
  await expect(versions.getByRole("listitem").filter({ hasText: "Version 2" }))
    .toContainText("The water company asks for test cock 4 now");

  // Version 1 is still there to read, as an inspection done under it was asked.
  await versions.getByRole("listitem").filter({ hasText: "Version 1" }).getByRole("link", { name: "See it" }).click();
  const first = owner.getByRole("region", { name: "Version 1" });
  await expect(first).toContainText("Every 12 months");
  await expect(first).toContainText("First check valve holds");
  await expect(first).not.toContainText(`Test cock 4 seals ${run}`);

  const detail = await api<{ program: { version: number; frequencyMonths: number; copiedFrom: { kind: string; code: string } }; versions: { version: number }[] }>(
    owner, `/v1/inspection-programs/${id}`);
  expect(detail.program).toMatchObject({ version: 2, frequencyMonths: 24, copiedFrom: { kind: "trade_pack", code: "backflow-annual" } });
  expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);

  // Stopping offering it keeps it, with its versions, under "Not offered".
  await owner.goto(`/inspections/programmes/${id}`);
  await owner.getByRole("button", { name: "Stop offering it to technicians" }).click();
  await expect(owner.getByText("Not offered", { exact: true })).toBeVisible();
  await owner.goto("/inspections/programmes");
  await expect(owner.getByRole("region", { name: "Not offered" }).getByRole("link", { name })).toBeVisible();
});
