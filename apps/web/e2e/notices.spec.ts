import { test, expect, run } from "./fixtures";

/**
 * NOTICES TO THE COMPANY'S OWN PEOPLE
 *
 * The office gives Ray a task from the queue; Ray's bell, on his phone, says
 * so, and opening the notice goes to the task and marks it read. Then the owner
 * chooses on their own page where each kind of notice reaches them, and turns
 * texts to their own mobile on and off, ticking the box beside the words they
 * agree to. Every step is a screen.
 */

test("a task given to Ray rings his bell, and opening it goes to the task and marks it read", async ({ owner, tech }) => {
  const title = `Return the gauges ${run}`;

  // Everything, so the new task shows once it is added, whoever it is for.
  await owner.goto("/tasks?view=all");
  await owner.getByText("Add a task").click();
  await owner.getByLabel("What needs doing").fill(title);
  await owner.getByLabel("For").selectOption({ label: "Ray Ortiz" });
  await owner.getByRole("button", { name: "Add task" }).click();
  await expect(owner.getByText(title).first()).toBeVisible();

  // On his phone the bell is in the bar at the top, beside the menu.
  await tech.goto("/my-day");
  const bell = tech.locator('[data-bell="header"]');
  await expect(bell.locator("summary")).toHaveAttribute("aria-label", /Notices, \d+ unread/);
  await bell.locator("summary").click();
  const notice = bell.getByRole("region", { name: "Your notices" }).getByRole("link").filter({ hasText: `A task for you: ${title}` });
  await expect(notice).toContainText("A task given to you");
  await expect(notice).toContainText("unread");
  await notice.click();
  await expect(tech).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(tech.getByRole("heading", { level: 1, name: title })).toBeVisible();

  // Read now, on the whole list too.
  await tech.goto("/notices");
  const line = tech.getByRole("list", { name: "Your notices" }).getByRole("link").filter({ hasText: title });
  await expect(line).toContainText(", read");
  await expect(line).not.toContainText("unread");
});

test("the owner chooses where each kind of notice reaches them, and turns texts on and off themselves", async ({ owner }) => {
  await owner.goto("/me");
  const section = owner.locator("#notices");
  await expect(section.getByRole("heading", { name: "What you are told, and where" })).toBeVisible();

  // A text cannot be chosen before texts are on.
  await expect(section.getByRole("checkbox", { name: "A late task: by text" })).toBeDisabled();
  await section.getByRole("checkbox", { name: "A task given to you: on the phone app" }).uncheck();
  await section.getByRole("button", { name: "Save what I am told" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.reload();
  await expect(owner.locator("#notices").getByRole("checkbox", { name: "A task given to you: on the phone app" })).not.toBeChecked();
  await expect(owner.locator("#notices").getByRole("checkbox", { name: "A task given to you: in the app" })).toBeChecked();

  // Texts need the box ticked beside the words, then go to the number given.
  const texts = owner.locator("#notices");
  await texts.getByLabel("Your mobile number").fill("(512) 555-0177");
  await texts.getByRole("checkbox", { name: /Text me at this number/ }).check();
  await texts.getByRole("button", { name: "Turn texts on" }).click();
  await expect(texts.getByRole("status").filter({ hasText: "Texts are on." })).toBeVisible();
  await owner.reload();
  await expect(owner.locator("#notices")).toContainText("Texts go to +15125550177");

  const late = owner.locator("#notices").getByRole("checkbox", { name: "A late task: by text" });
  await expect(late).toBeEnabled();
  await late.check();
  await owner.locator("#notices").getByRole("button", { name: "Save what I am told" }).click();
  await expect(owner.locator("#notices").getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.reload();
  await expect(owner.locator("#notices").getByRole("checkbox", { name: "A late task: by text" })).toBeChecked();

  await owner.locator("#notices").getByRole("button", { name: "Turn texts off" }).click();
  await expect(owner.locator("#notices").getByRole("status").filter({ hasText: "Texts are off." })).toBeVisible();
  await owner.reload();
  await expect(owner.locator("#notices").getByRole("button", { name: "Turn texts on" })).toBeVisible();
});
