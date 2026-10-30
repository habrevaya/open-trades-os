import { test, expect, run } from "./fixtures";

/**
 * THE AUTOMATION CANVAS: A STEP THAT EMAILS A WHOLE DASHBOARD
 *
 * "Run and email a report" offers the dashboards beside the reports. Picking
 * one hides the dates and the customer choice, because a dashboard is sent as
 * it stands and only to people, and says so under it. Saved and opened again,
 * it is the same picture, stored as the dashboard schedules store it.
 */
test("a step that emails a dashboard is drawn, saved with no dates, and opens again the same", async ({ owner }) => {
  const name = `Monday board to the books ${run}`;
  await owner.goto("/automations/new");
  await owner.getByRole("textbox", { name: "Name" }).fill(name);
  await owner.getByRole("button", { name: "Remove step 1, Raise a task" }).click();
  await owner.getByRole("button", { name: "Add a step to the end" }).click();
  await owner.getByRole("button", { name: "Add Run and email a report" }).click();

  const card = owner.getByRole("region", { name: "step 1, Run and email a report" });
  const pick = card.getByLabel("step 1, Run and email a report, report");
  // A report first, with its dates, then the dashboard in its place.
  await pick.selectOption("builtIn:ar-aging");
  await card.getByLabel("step 1, Run and email a report, which days it covers").selectOption("last_month");
  await pick.selectOption("dashboard:operations");
  await expect(card.getByLabel("step 1, Run and email a report, which days it covers")).toHaveCount(0);
  await expect(card.getByText("The customer this is about")).toHaveCount(0);
  await expect(card.getByText(/The whole dashboard is sent as one PDF/)).toBeVisible();
  await card.getByLabel("step 1, Run and email a report, outside addresses").fill(`books+${run}@accountant.test`);

  await owner.getByRole("checkbox", { name: /invoice\.issued/ }).check();
  await owner.getByRole("button", { name: "Save, switched off" }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();

  const id = owner.url().split("/automations/")[1]!.split(/[?#]/)[0]!;
  const saved = await (await owner.request.get(`/api/v1/workflows/${id}`)).json() as {
    steps: { kind: string; config: Record<string, unknown> }[];
  };
  expect(saved.steps[0]).toMatchObject({
    kind: "email_report",
    config: { report: "dashboard:operations", period: "all", userIds: [], addresses: [`books+${run}@accountant.test`] },
  });

  const again = owner.getByRole("region", { name: "step 1, Run and email a report" });
  await expect(again.getByLabel("step 1, Run and email a report, report")).toHaveValue("dashboard:operations");
  await expect(again.getByText(/The whole dashboard is sent as one PDF/)).toBeVisible();
});

test("a step that emails a dashboard to the customer is refused in words", async ({ owner }) => {
  const created = await owner.request.post("/api/v1/workflows", {
    data: {
      name: `Dashboard to a customer ${run}`, triggerKind: "event", triggerEvents: ["invoice.issued"],
      steps: [{ kind: "email_report", config: { report: "dashboard:operations", to: "customer" } }],
    },
  });
  expect(created.ok()).toBe(false);
  expect(JSON.stringify(await created.json())).toContain("A dashboard is the company's own, so it is never sent to a customer");
});
