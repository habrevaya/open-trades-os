import { test, expect, run, newCustomer } from "./fixtures";

/**
 * MOVING A RECORD TO ANOTHER JOB, ON ITS PAGE
 *
 * A permit filed on the wrong job is moved from the permit's own page: "Change
 * the job", find the right one by its words, "Point at this one", and the page
 * says the new job. "Take it off" removes a link. The technician, who was
 * never sent to either job, cannot open the page that changes it.
 */

test("a record's job is changed and taken off on its page, and the technician cannot reach the change", async ({ owner, tech, errors }) => {
  const key = `lnk_${run}`;
  const made = await owner.request.post("/api/v1/custom-objects", {
    headers: { "idempotency-key": `record-links-kind-${run}` },
    data: { key, label: `Permit ${run}`, titleLabel: "Permit number", links: ["customer", "job"] },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const kindId = (await made.json() as { id: string }).id;
  try {
    const customerId = await newCustomer(owner, {
      name: `Lena Links ${run}`, address: { street: `${run.slice(-4)} Linden Rd`, city: "Austin", state: "TX", zip: "78704" },
    });
    const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
    const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
    const jobIds: string[] = [];
    for (const [index, summary] of [`Attic fan ${run}`, `Crawlspace heater ${run}`].entries()) {
      const job = await owner.request.post("/api/v1/jobs", {
        headers: { "idempotency-key": `record-links-job-${run}-${index}` },
        data: { customerId, propertyId, summary },
      });
      expect(job.ok(), await job.text()).toBe(true);
      jobIds.push((await job.json() as { id: string }).id);
    }
    const filed = await owner.request.post("/api/v1/custom-records", {
      headers: { "idempotency-key": `record-links-record-${run}` },
      data: { type: key, title: `PX-${run}`, jobId: jobIds[0] },
    });
    expect(filed.ok(), await filed.text()).toBe(true);
    const recordId = (await filed.json() as { id: string }).id;

    await owner.goto(`/records/${key}/${recordId}`);
    const links = owner.getByRole("list", { name: "What it points at" });
    await expect(links.getByRole("listitem").filter({ hasText: "Job" })).toContainText(`Attic fan ${run}`);
    await links.getByRole("link", { name: "Change the job" }).click();
    await expect(owner.getByRole("heading", { name: "Choose the job" })).toBeVisible();
    await owner.getByRole("searchbox", { name: "Find the job" }).fill(`crawlspace ${run}`);
    await owner.getByRole("searchbox", { name: "Find the job" }).press("Enter");
    const choices = owner.getByRole("list", { name: "Choices" });
    await expect(choices.getByRole("listitem")).toHaveCount(1);
    await choices.getByRole("listitem").filter({ hasText: `Crawlspace heater ${run}` })
      .getByRole("button", { name: "Point at this one" }).click();

    await expect(owner).toHaveURL(new RegExp(`/records/${key}/${recordId}$`));
    const jobRow = owner.getByRole("list", { name: "What it points at" }).getByRole("listitem").filter({ hasText: "Job" });
    await expect(jobRow).toContainText(`Crawlspace heater ${run}`);

    await jobRow.getByRole("button", { name: "Take it off" }).click();
    await expect(jobRow).toContainText("Nothing");
    const after = await owner.request.get(`/api/v1/custom-records/${recordId}`);
    expect((await after.json() as { job: unknown }).job).toBeNull();

    // The technician was sent to neither job and may not change records: the page that changes one is not there for them.
    const page = await tech.goto(`/records/${key}/${recordId}/link?to=job`);
    expect(page?.status()).toBe(404);
  } finally {
    await owner.request.delete(`/api/v1/custom-objects/${kindId}?force=true`);
  }
  expect(errors).toEqual([]);
});
