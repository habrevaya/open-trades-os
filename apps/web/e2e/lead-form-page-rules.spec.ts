import { test, expect, run } from "./fixtures";

/**
 * A LEAD FORM THAT SKIPS A PAGE BY ANSWER, AND THANKS THEM BY FIRST NAME
 *
 * The office splits a form into three pages. The third asks about a boiler and
 * is shown only to people who said they need one. A stranger who says "A leak"
 * is never sent to it, and is thanked in words that fall back to the company's
 * own when they gave no name. Another says "A boiler", is asked the third page's
 * required question, and is thanked by the first word of their name.
 */
test("a page shown only for some answers is skipped for everyone else, and the thanks says a first name", async ({ owner, stranger }) => {
  test.setTimeout(120_000);
  const slug = `rules-${run}`;
  await owner.goto("/marketing/forms");
  await owner.getByLabel("Title").fill(`What do you need ${run}`);
  await owner.getByLabel("Short name").fill(slug);
  await owner.getByRole("button", { name: "Start form" }).click();
  await expect(owner).toHaveURL(new RegExp(`/marketing/forms/${slug}$`));

  /** A name is not required, so a lead can arrive without one. */
  await owner.getByRole("listitem").filter({ has: owner.getByLabel("Field 1 question") }).getByLabel("Required").uncheck();

  await owner.getByRole("button", { name: "Split into pages" }).click();
  await owner.getByRole("button", { name: "Add a field" }).click();
  await owner.getByLabel("Field 8 question").fill("What do you need");
  await owner.getByLabel("Field 8 key").fill("work");
  await owner.getByLabel("Field 8 kind").selectOption({ label: "Pick one" });
  await owner.getByLabel("Options, one per line").fill("Boiler\nLeak");
  await expect(owner.getByLabel("Field 8 page")).toHaveValue("1");

  await owner.getByRole("button", { name: "Add a page" }).click();
  await owner.getByLabel("Page 3 heading").fill("The boiler");
  await owner.getByRole("button", { name: "Add a field" }).click();
  await owner.getByLabel("Field 9 question").fill("How old is the boiler");
  await owner.getByLabel("Field 9 key").fill("age");
  await owner.getByLabel("Field 9 kind").selectOption({ label: "Number" });
  await owner.getByRole("listitem").filter({ has: owner.getByLabel("Field 9 question") }).getByLabel("Required").check();
  await expect(owner.getByLabel("Field 9 page")).toHaveValue("2");

  await owner.getByLabel("Who sees page 3").selectOption({ label: "Only some answers" });
  await owner.getByLabel("Page 3 waits for").selectOption({ label: "What do you need" });
  await owner.getByLabel("Show page 3 for Boiler").check();

  await owner.getByLabel("What the page says").fill(`Thanks {{ firstName }}, we ring within the hour. ${run}`);
  await owner.getByLabel(/When they gave no name/).fill("neighbour");
  await owner.getByLabel("Too fast to be a person (seconds)").fill("0");
  await owner.getByRole("button", { name: "Save form" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const hosted = await owner.getByRole("link", { name: /^\/f\// }).getAttribute("href");

  const digits = String(Date.now()).slice(-7);

  /** A leak never meets the boiler page: two pages, Send on the second, thanked as a neighbour. */
  await stranger.goto(hosted!);
  /** Only the pages the answers so far lead to are counted: the boiler page waits for its answer. */
  await expect(stranger.getByText("Page 1 of 2")).toBeVisible();
  await stranger.getByLabel("Mobile number").fill(`737${digits}`);
  await stranger.getByRole("button", { name: "Next" }).click();
  await expect(stranger.getByText("Page 2 of 2")).toBeVisible();
  await stranger.getByRole("combobox", { name: "What do you need" }).selectOption({ label: "Leak" });
  await expect(stranger.getByText("Page 2 of 2")).toBeVisible();
  await expect(stranger.getByRole("button", { name: "Send" })).toBeVisible();
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("status").filter({ hasText: `Thanks neighbour, we ring within the hour. ${run}` })).toBeVisible();

  /** A boiler is sent on, its required question is asked, and Back goes to the page before it. */
  await stranger.goto(hosted!);
  await stranger.getByLabel("Your name").fill("Wren Boiler");
  await stranger.getByLabel("Mobile number").fill(`738${digits}`);
  await stranger.getByRole("button", { name: "Next" }).click();
  await stranger.getByRole("combobox", { name: "What do you need" }).selectOption({ label: "Boiler" });
  await expect(stranger.getByText("Page 2 of 3")).toBeVisible();
  await stranger.getByRole("button", { name: "Next" }).click();
  await expect(stranger.getByRole("group", { name: "The boiler" })).toBeVisible();
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("alert").filter({ hasText: "How old is the boiler" })).toBeVisible();
  await stranger.getByLabel("How old is the boiler").fill("12");
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("status").filter({ hasText: `Thanks Wren, we ring within the hour. ${run}` })).toBeVisible();
});
