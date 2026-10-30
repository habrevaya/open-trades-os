import { test, expect, run } from "./fixtures";

/**
 * THE RECORD QUESTION ON THE CANVAS, COMPARED WITH A VALUE TYPED IN
 *
 * "Stop unless still true" can ask whether a field on one of the company's
 * own records still says what the event carried, or still says a value typed
 * into the step. The owner draws one that compares with a typed value, sees the
 * box for it and the words under it, saves, and opens it again to the same
 * picture. A typed comparison with no value is refused where it can be fixed.
 */
test("a stop unless step compares a record's field with a value typed into it", async ({ owner }) => {
  const name = `Chase the permit ${run}`;
  await owner.goto("/automations/new");
  await owner.getByRole("textbox", { name: "Name" }).fill(name);

  await owner.getByRole("button", { name: "Add a step to the end" }).click();
  await owner.getByRole("button", { name: "Add Stop unless still true" }).click();
  const step = owner.getByRole("region", { name: "step 2, Stop unless still true" });
  await step.getByRole("combobox", { name: "Carry on only while" }).selectOption("record_field_unchanged");
  await step.getByRole("textbox", { name: /^Which field/ }).fill("status");

  // The default is what the event said, and there is no box for a value.
  const compare = step.getByRole("combobox", { name: "Compare the field with" });
  await expect(compare).toHaveValue("event");
  await expect(step.getByRole("textbox", { name: "The value it has to still be" })).toHaveCount(0);

  await compare.selectOption("value");
  const value = step.getByRole("textbox", { name: "The value it has to still be" });
  await expect(value).toBeVisible();
  await expect(step.getByText(/a yes or no field as yes or no/)).toBeVisible();
  await value.fill("approved");

  await owner.getByRole("checkbox", { name: /record\.updated/ }).check();
  await owner.getByRole("button", { name: "Save, switched off" }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();

  const id = owner.url().split("/automations/")[1]!.split(/[?#]/)[0]!;
  const saved = await (await owner.request.get(`/api/v1/workflows/${id}`)).json() as {
    steps: { kind: string; config: Record<string, unknown> }[];
  };
  expect(saved.steps[1]).toMatchObject({
    kind: "stop_unless", config: { check: "record_field_unchanged", field: "status", compare: "value", value: "approved" },
  });

  // It opens as the same picture.
  const reopened = owner.getByRole("region", { name: "step 2, Stop unless still true" });
  await expect(reopened.getByRole("combobox", { name: "Compare the field with" })).toHaveValue("value");
  await expect(reopened.getByRole("textbox", { name: "The value it has to still be" })).toHaveValue("approved");

  // Back to what the event said: the box goes.
  await reopened.getByRole("combobox", { name: "Compare the field with" }).selectOption("event");
  await expect(reopened.getByRole("textbox", { name: "The value it has to still be" })).toHaveCount(0);
});

test("a typed comparison with no value is refused where it can be fixed", async ({ owner }) => {
  await owner.goto("/automations/new");
  await owner.getByRole("textbox", { name: "Name" }).fill(`Empty value ${run}`);
  await owner.getByRole("button", { name: "Add a step to the end" }).click();
  await owner.getByRole("button", { name: "Add Stop unless still true" }).click();
  const step = owner.getByRole("region", { name: "step 2, Stop unless still true" });
  await step.getByRole("combobox", { name: "Carry on only while" }).selectOption("record_field_unchanged");
  await step.getByRole("textbox", { name: /^Which field/ }).fill("status");
  await step.getByRole("combobox", { name: "Compare the field with" }).selectOption("value");
  await owner.getByRole("checkbox", { name: /record\.updated/ }).check();
  await owner.getByRole("button", { name: "Save, switched off" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Type the value status has to still be" })).toBeVisible();
});
