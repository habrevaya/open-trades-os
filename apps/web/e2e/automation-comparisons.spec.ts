import { test, expect, run } from "./fixtures";

/**
 * THE RECORD QUESTION ON THE CANVAS: GREATER, LESS, ONE OF AND STILL BLANK
 *
 * "Stop unless still true" can ask whether a field on one of the company's own
 * records is greater or less than a typed value, one of several, or still
 * blank. The owner draws each, sees the box it needs and the words under it,
 * saves, and opens it again to the same picture. One with nothing typed is
 * refused where it can be fixed.
 */
test("a stop unless step asks greater than, one of and still blank of a record's field", async ({ owner }) => {
  const name = `Chase the fee ${run}`;
  await owner.goto("/automations/new");
  await owner.getByRole("textbox", { name: "Name" }).fill(name);

  const addCheck = async (n: number) => {
    await owner.getByRole("button", { name: "Add a step to the end" }).click();
    await owner.getByRole("button", { name: "Add Stop unless still true" }).click();
    const step = owner.getByRole("region", { name: `step ${n}, Stop unless still true` });
    await step.getByRole("combobox", { name: "Carry on only while" }).selectOption("record_field_unchanged");
    return step;
  };

  const greater = await addCheck(2);
  await greater.getByRole("textbox", { name: /^Which field/ }).fill("fee");
  await greater.getByRole("combobox", { name: "Compare the field with" }).selectOption("greater");
  await expect(greater.getByText(/where greater means later/)).toBeVisible();
  await greater.getByRole("textbox", { name: "The value it has to stay greater than" }).fill("500");

  const oneOf = await addCheck(3);
  await oneOf.getByRole("textbox", { name: /^Which field/ }).fill("status");
  await oneOf.getByRole("combobox", { name: "Compare the field with" }).selectOption("one_of");
  await oneOf.getByRole("textbox", { name: "The values it may be, one to a line" }).fill("submitted\napproved");

  const blank = await addCheck(4);
  await blank.getByRole("textbox", { name: /^Which field/ }).fill("inspector");
  await blank.getByRole("combobox", { name: "Compare the field with" }).selectOption("blank");
  await expect(blank.getByRole("textbox", { name: /^The value/ })).toHaveCount(0);
  await expect(blank.getByText(/stops once somebody does/)).toBeVisible();

  await owner.getByRole("checkbox", { name: /record\.updated/ }).check();
  await owner.getByRole("button", { name: "Save, switched off" }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();

  const id = owner.url().split("/automations/")[1]!.split(/[?#]/)[0]!;
  const saved = await (await owner.request.get(`/api/v1/workflows/${id}`)).json() as {
    steps: { kind: string; config: Record<string, unknown> }[];
  };
  expect(saved.steps.slice(1).map((s) => s.config)).toEqual([
    { check: "record_field_unchanged", field: "fee", compare: "greater", value: "500" },
    { check: "record_field_unchanged", field: "status", compare: "one_of", values: ["submitted", "approved"] },
    { check: "record_field_unchanged", field: "inspector", compare: "blank" },
  ]);

  // It opens as the same picture.
  await expect(owner.getByRole("region", { name: "step 2, Stop unless still true" })
    .getByRole("textbox", { name: "The value it has to stay greater than" })).toHaveValue("500");
  await expect(owner.getByRole("region", { name: "step 3, Stop unless still true" })
    .getByRole("textbox", { name: "The values it may be, one to a line" })).toHaveValue("submitted\napproved");
  await expect(owner.getByRole("region", { name: "step 4, Stop unless still true" })
    .getByRole("combobox", { name: "Compare the field with" })).toHaveValue("blank");
});

test("a one of with nothing typed is refused where it can be fixed", async ({ owner }) => {
  await owner.goto("/automations/new");
  await owner.getByRole("textbox", { name: "Name" }).fill(`Empty list ${run}`);
  await owner.getByRole("button", { name: "Add a step to the end" }).click();
  await owner.getByRole("button", { name: "Add Stop unless still true" }).click();
  const step = owner.getByRole("region", { name: "step 2, Stop unless still true" });
  await step.getByRole("combobox", { name: "Carry on only while" }).selectOption("record_field_unchanged");
  await step.getByRole("textbox", { name: /^Which field/ }).fill("status");
  await step.getByRole("combobox", { name: "Compare the field with" }).selectOption("one_of");
  await owner.getByRole("checkbox", { name: /record\.updated/ }).check();
  await owner.getByRole("button", { name: "Save, switched off" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Type the values status may be, one to a line" })).toBeVisible();
});
