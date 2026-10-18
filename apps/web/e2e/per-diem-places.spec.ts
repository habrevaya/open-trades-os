import { test, expect, run, newCustomer, companyToday } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * A DAY AWAY THAT IS WORTH SOMETHING ELSE IN SOME PLACES
 *
 * The owner lists a place with a city and a day rate and another that is only ever chosen by hand.
 * The office records days against a job: the place whose city is the job's city is picked for
 * them, a city no place names is never guessed at and they are asked to choose, and each day keeps
 * the place and the rate it was worked out at.
 */

async function jobIn(owner: Page, city: string): Promise<number> {
  const customerId = await newCustomer(owner, {
    name: `Perdie ${city}`, address: { street: "4 Away Road", city, state: "TX", zip: "78666" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const made = await owner.request.post("/api/v1/jobs", { data: { customerId, propertyId, summary: `Work in ${city}` } });
  expect(made.ok()).toBe(true);
  const job = await (await owner.request.get(`/api/v1/jobs/${(await made.json() as { id: string }).id}`)).json() as { number: number };
  return job.number;
}

test("a day away is worked out at the place of the job, and a city nobody listed is never guessed", async ({ owner }) => {
  test.setTimeout(180_000);
  // Letters only: a city is a name, and the run suffix makes this run's rows its own.
  const city = `Hillcrest${run.replace(/[0-9]/g, "x")}`;
  const hill = `Hill country ${run}`;
  const far = `Far away ${run}`;
  const elsewhere = `Elsewhere${run.replace(/[0-9]/g, "y")}`;
  const hillJob = await jobIn(owner, city);
  const elsewhereJob = await jobIn(owner, elsewhere);
  const since = "2026-01-01";
  const days = owner.getByRole("table", { name: "Days away" });

  try {
    // The owner lists the places.
    await owner.goto("/payroll/pay-rules");
    const places = owner.getByRole("region", { name: "Days away by place" });
    await places.getByLabel("Name of the place").fill(hill);
    await places.getByLabel("A day there is worth (dollars)").fill("ninety");
    await places.getByLabel("City, so jobs there pick it (optional)").fill(city);
    await places.getByLabel("State, two letters (optional)").fill("TX");
    await places.getByLabel("Worth that from").fill(since);
    await places.getByRole("button", { name: "Add the place" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "dollars and cents" })).toBeVisible();
    await places.getByLabel("A day there is worth (dollars)").fill("90.00");
    await places.getByRole("button", { name: "Add the place" }).click();
    await expect(places.getByRole("status").filter({ hasText: "Added." })).toBeVisible();

    await places.getByLabel("Name of the place").fill(far);
    await places.getByLabel("A day there is worth (dollars)").fill("120");
    await places.getByLabel("City, so jobs there pick it (optional)").fill("");
    await places.getByLabel("State, two letters (optional)").fill("");
    await places.getByLabel("Worth that from").fill(since);
    await places.getByRole("button", { name: "Add the place" }).click();
    await expect(places.getByRole("status").filter({ hasText: "Added." })).toBeVisible();
    const table = places.getByRole("table", { name: "Places" });
    await expect(table.getByRole("row").filter({ hasText: hill })).toContainText("$90.00");
    await expect(table.getByRole("row").filter({ hasText: far })).toContainText("Chosen by hand");

    // The same name twice is refused in words.
    await places.getByLabel("Name of the place").fill(hill.toLowerCase());
    await places.getByLabel("A day there is worth (dollars)").fill("95");
    await places.getByRole("button", { name: "Add the place" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "already a place called" })).toBeVisible();

    // The office records two days on the job in that city: the place is picked from the address.
    await owner.goto("/timesheets/expenses");
    const form = async (job: number, from: string, to: string, where?: string) => {
      await owner.getByLabel("Who was away").selectOption({ label: "Ray Ortiz" });
      await owner.getByLabel("Job number").fill(String(job));
      await owner.getByLabel("First day away").fill(from);
      await owner.getByLabel("Last day away").fill(to);
      await owner.getByLabel("Where they were").selectOption(where ?? { index: 0 });
      await owner.getByRole("button", { name: "Record the days" }).click();
    };
    expect(companyToday() > "2026-03-10").toBe(true);
    await form(hillJob, "2026-03-02", "2026-03-03");
    await expect(owner.getByRole("status").filter({ hasText: new RegExp(`2 days recorded in ${hill} at 90\\.00`) })).toBeVisible();
    await expect(days.getByRole("row").filter({ hasText: "Mar 2, 2026" })).toContainText(hill);
    await expect(days.getByRole("row").filter({ hasText: "Mar 2, 2026" })).toContainText("$90.00");

    // A city nobody listed is never guessed at: the office is asked to choose.
    await form(elsewhereJob, "2026-03-04", "2026-03-04");
    await expect(owner.getByRole("alert").filter({ hasText: "No place on the list is" }))
      .toContainText(`${elsewhere}, TX`);
    await expect(days.getByRole("row").filter({ hasText: "Mar 4, 2026" })).toHaveCount(0);

    // Choosing the place by hand records it, in the same trip as the first two days but as an entry of its own.
    await form(elsewhereJob, "2026-03-03", "2026-03-04", far);
    await expect(owner.getByRole("status").filter({ hasText: new RegExp(`1 day recorded in ${far} at 120\\.00. 1 already had one`) })).toBeVisible();
    await expect(days.getByRole("row").filter({ hasText: "Mar 4, 2026" })).toContainText("$120.00");
    await expect(days.getByRole("row").filter({ hasText: "Mar 3, 2026" })).toContainText(hill);

    // The API says the same.
    const listed = await owner.request.get("/api/v1/per-diem?from=2026-03-02&to=2026-03-04");
    const rows = ((await listed.json()) as { perDiems: { day: string; amount: string; placeName: string | null }[] }).perDiems
      .filter((d) => d.placeName === hill || d.placeName === far);
    expect(rows.map((d) => [d.day, d.amount, d.placeName]).sort()).toEqual([
      ["2026-03-02", "90.0000", hill], ["2026-03-03", "90.0000", hill], ["2026-03-04", "120.0000", far],
    ]);
  } finally {
    // Put it back: the days out, the places no longer used.
    await owner.goto("/timesheets/expenses");
    for (const day of ["2026-03-02", "2026-03-03", "2026-03-04"]) {
      const buttons = days.getByRole("button", { name: new RegExp(`^Take out Ray Ortiz's ${day}`) });
      if (await buttons.count() > 0) {
        await buttons.first().click();
        await expect(buttons).toHaveCount(0);
      }
    }
    await owner.goto("/payroll/pay-rules");
    for (const name of [hill, far]) {
      const stop = owner.getByRole("button", { name: `Stop using ${name}` });
      if (await stop.count() > 0) {
        await stop.locator("xpath=ancestor::details").locator("summary").click();
        await stop.click();
        await expect(owner.getByRole("button", { name: `Stop using ${name}` })).toHaveCount(0);
      }
    }
  }
});

test("a place takes a new rate from a day, and keeps the old ones on its list", async ({ owner }) => {
  const name = `Coast ${run}`;
  await owner.goto("/payroll/pay-rules");
  const places = owner.getByRole("region", { name: "Days away by place" });
  try {
    await places.getByLabel("Name of the place").fill(name);
    await places.getByLabel("A day there is worth (dollars)").fill("100");
    await places.getByLabel("Worth that from").fill("2026-01-01");
    await places.getByRole("button", { name: "Add the place" }).click();
    await expect(places.getByRole("status").filter({ hasText: "Added." })).toBeVisible();

    const row = places.getByRole("table", { name: "Places" }).getByRole("row").filter({ hasText: name });
    await row.getByText("Change or stop using").click();
    await row.getByLabel(`New day rate for ${name} (dollars)`).fill("110");
    await row.getByLabel(`Starting on, for ${name}`).fill("2026-06-01");
    await row.getByRole("button", { name: `Add a rate for ${name}` }).click();
    await expect(places.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(row).toContainText("$110.00 from Jun 1, 2026");
    await expect(row).toContainText("$100.00 from Jan 1, 2026");
  } finally {
    await owner.goto("/payroll/pay-rules");
    const stop = owner.getByRole("button", { name: `Stop using ${name}` });
    if (await stop.count() > 0) {
      await stop.locator("xpath=ancestor::details").locator("summary").click();
      await stop.click();
      await expect(owner.getByRole("button", { name: `Stop using ${name}` })).toHaveCount(0);
    }
  }
});
