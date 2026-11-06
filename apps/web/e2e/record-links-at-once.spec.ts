import { test, expect, run, newCustomer } from "./fixtures";

/**
 * MOVING A RECORD'S CUSTOMER AND JOB TOGETHER
 *
 * A permit filed against the wrong customer and the wrong job is put right on
 * one form: "Change several at once", words in the customer box and the job
 * box, "Find", one pick under each, "Save these changes", and the record's
 * page says both new ones. Saving with nothing chosen is refused in words.
 */

test("a record's customer and job are changed together on one form", async ({ owner, errors }) => {
  const key = `lnks_${run}`;
  const made = await owner.request.post("/api/v1/custom-objects", {
    headers: { "idempotency-key": `record-links-at-once-kind-${run}` },
    data: { key, label: `Permit ${run}`, titleLabel: "Permit number", links: ["customer", "job"] },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const kindId = (await made.json() as { id: string }).id;
  try {
    const ids: { customer: string; job: string }[] = [];
    for (const [index, who] of [`Wren Wrong ${run}`, `Rita Right ${run}`].entries()) {
      const customerId = await newCustomer(owner, {
        name: who, address: { street: `${run.slice(-4)}${index} Many Rd`, city: "Austin", state: "TX", zip: "78704" },
      });
      const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
      const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
      const job = await owner.request.post("/api/v1/jobs", {
        headers: { "idempotency-key": `record-links-at-once-job-${run}-${index}` },
        data: { customerId, propertyId, summary: `${index === 0 ? "Wrong" : "Right"} panel ${run}` },
      });
      expect(job.ok(), await job.text()).toBe(true);
      ids.push({ customer: customerId, job: (await job.json() as { id: string }).id });
    }
    const filed = await owner.request.post("/api/v1/custom-records", {
      headers: { "idempotency-key": `record-links-at-once-record-${run}` },
      data: { type: key, title: `PM-${run}`, customerId: ids[0]!.customer, jobId: ids[0]!.job },
    });
    expect(filed.ok(), await filed.text()).toBe(true);
    const recordId = (await filed.json() as { id: string }).id;

    await owner.goto(`/records/${key}/${recordId}`);
    await owner.getByRole("link", { name: "Change several at once" }).click();
    await expect(owner.getByRole("heading", { name: "Change what it points at" })).toBeVisible();

    /** Nothing chosen is refused in words. */
    await owner.getByRole("button", { name: "Save these changes" }).click();
    await expect(owner.getByText("Choose at least one change, or go back to the record.")).toBeVisible();

    const find = owner.getByRole("form", { name: "Find what to point at" });
    await find.getByLabel("Find the customer").fill(`Rita Right ${run}`);
    await find.getByLabel("Find the job").fill(`right panel ${run}`);
    await find.getByRole("button", { name: "Find" }).click();
    await owner.getByLabel(`Customer: Rita Right ${run}`).check();
    await owner.getByRole("radio", { name: new RegExp(`Job: Job \\d+: Right panel ${run}`) }).check();
    await owner.getByRole("button", { name: "Save these changes" }).click();

    await expect(owner).toHaveURL(new RegExp(`/records/${key}/${recordId}$`));
    const links = owner.getByRole("list", { name: "What it points at" });
    await expect(links.getByRole("listitem").filter({ hasText: "Customer" })).toContainText(`Rita Right ${run}`);
    await expect(links.getByRole("listitem").filter({ hasText: "Job" })).toContainText(`Right panel ${run}`);
  } finally {
    await owner.request.delete(`/api/v1/custom-objects/${kindId}?force=true`);
  }
  expect(errors).toEqual([]);
});
