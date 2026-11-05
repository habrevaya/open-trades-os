import { test, expect, run } from "./fixtures";

/**
 * A LEAD FORM QUESTION ASKED ONLY FOR SOME ANSWERS, BY A RULE OVER TWO
 *
 * The office adds a serial number question asked only when the person picked
 * a boiler AND said it is more than fifteen years old. On the hosted page the
 * question appears only once both are true, is required then, and a person
 * with a furnace is never asked it and can send without it.
 */
test("a question shown by a rule over two earlier answers is asked only when both hold", async ({ owner, stranger }) => {
  test.setTimeout(120_000);
  const slug = `several-${run}`;
  await owner.goto("/marketing/forms");
  await owner.getByLabel("Title").fill(`Old boilers ${run}`);
  await owner.getByLabel("Short name").fill(slug);
  await owner.getByRole("button", { name: "Start form" }).click();
  await expect(owner).toHaveURL(new RegExp(`/marketing/forms/${slug}$`));

  await owner.getByRole("button", { name: "Add a field" }).click();
  await owner.getByLabel("Field 8 question").fill("What needs work");
  await owner.getByLabel("Field 8 key").fill("system");
  await owner.getByLabel("Field 8 kind").selectOption({ label: "Pick one" });
  await owner.getByLabel("Options, one per line").fill("Boiler\nFurnace");

  await owner.getByRole("button", { name: "Add a field" }).click();
  await owner.getByLabel("Field 9 question").fill("How old is it");
  await owner.getByLabel("Field 9 key").fill("age");
  await owner.getByLabel("Field 9 kind").selectOption({ label: "Number" });

  await owner.getByRole("button", { name: "Add a field" }).click();
  await owner.getByLabel("Field 10 question").fill("Serial number");
  await owner.getByLabel("Field 10 key").fill("serial");
  await owner.getByRole("listitem").filter({ has: owner.getByLabel("Field 10 question") }).getByLabel("Required").check();
  await owner.getByLabel("Who is asked field 10").selectOption({ label: "Answers that match a rule" });
  await owner.getByLabel("Field 10 condition 1 question").selectOption({ label: "What needs work" });
  await owner.getByLabel("Field 10 condition 1 test").selectOption({ label: "is" });
  await owner.getByLabel("Field 10 condition 1 answer").selectOption({ label: "Boiler" });
  await owner.getByRole("button", { name: "Field 10 add a condition" }).click();
  await owner.getByLabel("Field 10 condition 2 question").selectOption({ label: "How old is it" });
  await owner.getByLabel("Field 10 condition 2 test").selectOption({ label: "is more than" });
  await owner.getByLabel("Field 10 condition 2 answer").fill("15");
  await expect(owner.getByLabel("Field 10 all or any")).toHaveValue("all");

  await owner.getByLabel("What the page says").fill(`Thanks, we will ring you. ${run}`);
  await owner.getByLabel("Too fast to be a person (seconds)").fill("0");
  await owner.getByRole("button", { name: "Save form" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  /** The rule is kept with the question, ready to change. */
  await owner.reload();
  await expect(owner.getByLabel("Who is asked field 10")).toHaveValue("rule");
  await expect(owner.getByLabel("Field 10 condition 2 answer")).toHaveValue("15");
  const hosted = await owner.getByRole("link", { name: /^\/f\// }).getAttribute("href");
  const digits = String(Date.now()).slice(-7);

  /** A furnace is never asked for the serial number. */
  await stranger.goto(hosted!);
  await stranger.getByLabel("Your name").fill("Ada Furnace");
  await stranger.getByLabel("Mobile number").fill(`737${digits}`);
  await stranger.getByRole("combobox", { name: "What needs work" }).selectOption({ label: "Furnace" });
  await stranger.getByLabel("How old is it").fill("20");
  await expect(stranger.getByLabel("Serial number")).toBeHidden();
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("status").filter({ hasText: `Thanks, we will ring you. ${run}` })).toBeVisible();

  /** An old boiler is: the question appears once both answers hold, and is required. */
  await stranger.goto(hosted!);
  await stranger.getByLabel("Your name").fill("Wren Boiler");
  await stranger.getByLabel("Mobile number").fill(`738${digits}`);
  await stranger.getByRole("combobox", { name: "What needs work" }).selectOption({ label: "Boiler" });
  await stranger.getByLabel("How old is it").fill("9");
  await expect(stranger.getByLabel("Serial number")).toBeHidden();
  await stranger.getByLabel("How old is it").fill("22");
  await expect(stranger.getByLabel("Serial number")).toBeVisible();
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("alert").filter({ hasText: "Serial number" })).toBeVisible();
  await stranger.getByLabel("Serial number").fill("WB-2004-118");
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("status").filter({ hasText: `Thanks, we will ring you. ${run}` })).toBeVisible();
});
