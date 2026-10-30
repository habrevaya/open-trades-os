import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A COST THAT MAY BE COUNTED TWICE
 *
 * A subcontractor's line is on a job at $412.50, and the bookkeeper journals a
 * $412.50 bill to the same job. The job page says the cost may be counted
 * twice, with both figures left as they are; the owner, who posts journals,
 * says they are two different costs, and the warning becomes a note of who
 * checked it, which can be taken back.
 *
 * The customer, the job and the journal are made through the API, and the
 * line is written straight to the database, because none of them is what is
 * being tested.
 */
test("a journalled cost that matches a line is flagged, and can be marked as a different cost", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Dee Double ${run}`, address: { street: "8 Twice Ave", city: "Austin", state: "TX", zip: "78704" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const booked = await owner.request.post("/api/v1/jobs", {
    data: { customerId, propertyId, summary: `Attic ducts ${run}` },
  });
  expect(booked.ok()).toBe(true);
  const jobId = (await booked.json() as { id: string }).id;

  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, unit_cost, non_billable_reason)
      select organization_id, id, 'subcontractor', ${`Duct crew ${run}`}, 1, 0, 412.50, 'In the quoted price'
      from public.job where id = ${jobId}::uuid`);
  } finally {
    await db.$close();
  }

  const posted = await owner.request.post("/api/v1/ledger/journal-entries", {
    data: {
      memo: `Duct crew bill ${run}`,
      lines: [{ accountCode: "5000", debit: "412.50", jobId }, { accountCode: "1000", credit: "412.50" }],
    },
  });
  expect(posted.ok()).toBe(true);

  await owner.goto(`/jobs/${jobId}`);
  const costing = owner.getByRole("region", { name: "Job costing" });
  const warning = costing.getByTestId("double-counts");
  await expect(warning).toContainText("This cost may be counted twice.");
  await expect(warning).toContainText(`Duct crew ${run}`);
  await expect(warning).toContainText("Same amount, on the same day.");
  // Both are in materials, and the warning does not change that.
  await expect(costing.locator('dt:text-is("Materials") + dd')).toHaveText("$825.00");

  await warning.getByLabel("Why (optional)").fill("Second crew, second bill");
  await warning.getByRole("button", { name: "Not the same cost" }).click();
  await expect(warning).toContainText("Checked: these look alike but are different costs.");
  await expect(warning).toContainText("Second crew, second bill");
  await expect(costing.locator('dt:text-is("Materials") + dd')).toHaveText("$825.00");

  // Taken back, the warning is there again.
  await warning.getByRole("button", { name: "Take back" }).click();
  await expect(warning).toContainText("This cost may be counted twice.");
});
