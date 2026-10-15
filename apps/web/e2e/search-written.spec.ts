import { test, expect, run, newCustomer } from "./fixtures";

/**
 * FIND THE WORK BY WHAT WAS WRITTEN ON IT
 *
 * The office remembers "the one with the cracked heat exchanger", not the
 * job number. The box finds the job by a word only in its description and
 * the invoice by a word only on one of its lines, and the job list's own
 * search agrees. The technician, never sent to that job, types the same
 * words and finds nothing: what was written on work they cannot open is not
 * a way in.
 */

const jobWord = `marigold${run}`;
const lineWord = `periwinkle${run}`;

test("The search box finds a job by its description and an invoice by a line, and the technician finds neither", async ({ owner, tech, errors }) => {
  const customerId = await newCustomer(owner, {
    name: `Written Search ${run}`,
    address: { street: `${run} Larkspur Ave`, city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
  expect(places.ok()).toBe(true);
  const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const made = await owner.request.post("/api/v1/jobs", {
    headers: { "idempotency-key": `written-search-job-${run}` },
    data: { customerId, propertyId, summary: "Service call", description: `Heat exchanger cracked, ${jobWord} noted` },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const jobId = (await made.json() as { id: string }).id;
  const invoiced = await owner.request.post("/api/v1/invoices", {
    headers: { "idempotency-key": `written-search-invoice-${run}` },
    data: {
      customerId, jobId, draft: true,
      lines: [{ name: "Gas valve", description: `Fitted the ${lineWord} valve`, unitPrice: "180.00" }],
    },
  });
  expect(invoiced.ok(), await invoiced.text()).toBe(true);

  await owner.goto("/jobs");
  const box = owner.locator('input[aria-label="Find anything"]:visible');
  await box.fill(jobWord);
  await box.press("Enter");
  await expect(owner).toHaveURL(/\/search\?q=/);
  const jobs = owner.getByRole("region", { name: "Jobs" });
  await expect(jobs.getByRole("listitem")).toHaveCount(1);
  await expect(jobs).toContainText(`Written Search ${run}`);

  await owner.goto(`/search?q=${encodeURIComponent(lineWord)}`);
  await expect(owner.getByRole("region", { name: "Invoices" })).toContainText(`Written Search ${run}`);

  // The job list's own box reads the same words the same way.
  await owner.goto(`/jobs?q=${encodeURIComponent(`written ${jobWord}`)}`);
  await expect(owner.getByRole("table").getByRole("row")).toHaveCount(2);
  await expect(owner.getByRole("table")).toContainText(`Written Search ${run}`);

  // The technician was never sent to this job, so neither word finds anything.
  for (const word of [jobWord, lineWord]) {
    await tech.goto(`/search?q=${encodeURIComponent(word)}`);
    await expect(tech.getByText("Nothing found")).toBeVisible();
    await expect(tech.getByText(`Written Search ${run}`)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
