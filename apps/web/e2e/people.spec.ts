import { test, expect, run, companyToday } from "./fixtures";

/**
 * A NEW TECHNICIAN'S FIRST WEEK, FROM BOTH SIDES OF THE COUNTER
 *
 * The office writes the van agreement and puts it on the technician
 * checklist beside a ladder course, invites a technician and starts their
 * onboarding. The technician opens the invite link in a browser of their
 * own, chooses a password, signs the agreement by typing their name, ticks
 * the course, sees their onboarding done, and asks for a day off. The office
 * approves the day, and the technician sees the answer.
 *
 * Every step is a real form on a real screen: nothing here calls the API.
 */

/** A date `days` from the company's today, as a date input takes it. */
function companyDay(days: number): string {
  const [y, m, d] = companyToday().split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

test("a technician completes onboarding and asks for a day off that the office approves", async ({ owner, stranger }) => {
  const agreement = `Van agreement ${run}`;
  const ladder = `Ladder safety ${run}`;
  const name = `Tia Tech ${run}`;

  // The words the technician will sign.
  await owner.goto("/people/documents");
  await owner.getByLabel("Title").fill(agreement);
  await owner.getByLabel("The words they sign").fill(
    "The van is for work. No passengers who do not work here. Report every scratch the same day.",
  );
  await owner.getByRole("button", { name: "Save the document" }).click();
  await expect(owner.getByRole("status").filter({ hasText: `${agreement} is ready` })).toBeVisible();

  // The technician checklist: what earlier runs left is taken off, then the two lines this run needs.
  await owner.goto("/people/onboarding");
  const technicians = owner.locator("section", { has: owner.getByRole("heading", { name: "Technician", exact: true }) });
  for (let left = await technicians.getByRole("button", { name: "Remove" }).count(); left > 0; left -= 1) {
    await technicians.getByRole("button", { name: "Remove" }).first().click();
    await expect(technicians.getByRole("button", { name: "Remove" })).toHaveCount(left - 1);
  }
  const addLine = async (kind: string, label: string, document?: string) => {
    await owner.getByLabel("Role").selectOption({ label: "Technician" });
    await owner.getByLabel("Kind").selectOption({ label: kind });
    await owner.getByLabel("What").fill(label);
    if (document) await owner.getByLabel("Signed by them (documents only)").selectOption({ label: document });
    await owner.getByRole("button", { name: "Add line" }).click();
    await expect(owner.getByRole("listitem").filter({ hasText: label })).toBeVisible();
  };
  await addLine("Document", `${agreement} signed`, agreement);
  await addLine("Training", ladder);
  await expect(owner.getByRole("listitem").filter({ hasText: `${agreement} signed` })).toContainText(`done by signing ${agreement}`);

  // The invite, with its link shown once.
  await owner.goto("/settings/team");
  await owner.getByLabel("Their name").fill(name);
  await owner.getByLabel("Their email").fill(`tia+${run}@ridge.example`);
  // Technician is the role the form starts on for somebody who may give it.
  await expect(owner.getByRole("region", { name: "Invite somebody" }).locator("select[name=role]")).toHaveValue("technician");
  await owner.getByRole("button", { name: "Invite", exact: true }).click();
  const secret = owner.getByLabel("The token, which is not shown again");
  await expect(secret).toContainText("/welcome?token=");
  const link = new URL((await secret.textContent())!.trim());
  await expect(owner.getByRole("cell", { name: new RegExp(name) })).toContainText(/The link works until/);

  // Their onboarding, started from their page: the checklist copied, the agreement handed to them.
  await owner.goto("/people");
  await owner.getByRole("link", { name }).click();
  await owner.getByRole("button", { name: "Start onboarding" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "2 lines added." })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Documents to sign" }).getByRole("listitem").filter({ hasText: agreement }))
    .toContainText("Not yet");

  // The technician, in their own browser: a password, and they are in.
  await stranger.goto(`${link.pathname}${link.search}`);
  await stranger.getByLabel("Password").fill("a long enough password for a van");
  await stranger.getByRole("button", { name: "Set password and sign in" }).click();
  await expect(stranger).not.toHaveURL(/\/welcome/);

  await stranger.goto("/me");
  await expect(stranger.getByRole("heading", { level: 1, name })).toBeVisible();

  // The agreement, read and signed by typing their name.
  const toSign = stranger.getByRole("article", { name: agreement });
  await expect(toSign).toContainText("Report every scratch the same day.");
  await toSign.getByLabel("Your full name").fill(name);
  await toSign.getByRole("button", { name: `Sign ${agreement}` }).click();
  await expect(stranger.getByRole("region", { name: "Documents to sign" }).getByRole("listitem").filter({ hasText: agreement }))
    .toContainText(`typed as ${name}`);

  // The course, ticked by them.
  await stranger.getByRole("listitem").filter({ hasText: ladder }).getByRole("button", { name: "Done" }).click();
  await expect(stranger.getByText("Done: all 2 required lines ticked.")).toBeVisible();

  // A day off, a week out.
  const day = companyDay(7);
  await stranger.goto("/me/time-off");
  await stranger.getByLabel("First day off").fill(day);
  await stranger.getByLabel("Why (optional)").fill("Sister's wedding");
  await stranger.getByRole("button", { name: "Ask for these days" }).click();
  await expect(stranger.getByRole("status").filter({ hasText: "Asked." })).toBeVisible();
  await expect(stranger.getByRole("listitem").filter({ hasText: "Sister's wedding" })).toContainText("Waiting for an answer");

  // The office sees it signed and done, and approves the day.
  await owner.goto("/people");
  await expect(owner.getByRole("row").filter({ hasText: name })).toContainText("Done");
  await owner.goto("/timesheets/time-off");
  await owner.getByRole("button", { name: `Approve ${name}` }).click();
  // Answered, it leaves the queue and is listed with the leave still to come.
  await expect(owner.getByRole("region", { name: "Approved, still to come" }).getByRole("row").filter({ hasText: name }))
    .toContainText("Sister's wedding");
  await expect(owner.getByRole("region", { name: "Waiting for an answer" }).getByRole("row").filter({ hasText: name }))
    .toHaveCount(0);

  // And the technician sees the answer.
  await stranger.reload();
  await expect(stranger.getByRole("listitem").filter({ hasText: "Sister's wedding" })).toContainText("Approved");

  // A few hours, another day: asked for with times, and said with them on both screens.
  await stranger.getByLabel("First day off").fill(companyDay(9));
  await stranger.getByLabel("Only part of the day: from").fill("13:00");
  // Half asked is refused in words, and keeps what was typed.
  await stranger.getByRole("button", { name: "Ask for these days" }).click();
  await expect(stranger.getByRole("alert").filter({ hasText: "say when it starts and when it ends" })).toBeVisible();
  await stranger.getByLabel("Only part of the day: from").fill("13:00");
  await stranger.getByLabel("Only part of the day: until").fill("17:00");
  await stranger.getByLabel("Why (optional)").fill("Dentist");
  await stranger.getByRole("button", { name: "Ask for these days" }).click();
  await expect(stranger.getByRole("listitem").filter({ hasText: "Dentist" })).toContainText("1:00 PM to 5:00 PM");
  await owner.goto("/timesheets/time-off");
  await expect(owner.getByRole("region", { name: "Waiting for an answer" }).getByRole("row").filter({ hasText: "Dentist" }))
    .toContainText("1:00 PM to 5:00 PM");
});
