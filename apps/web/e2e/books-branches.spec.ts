import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A JOURNAL THAT SAYS WHAT IT IS ABOUT, AND A BRANCH'S BOOKS
 *
 * An accountant books a subcontractor's bill against one job in one branch,
 * from the form, naming the job by the number it is printed with and the
 * customer by their name. It then shows on the journal with its words, in the
 * job's own margin on the job page, and in the branch's trial balance, which
 * says how much of the books carries no branch.
 *
 * The branch, the customer and the job are made through the API, because they
 * are not what is being tested.
 */
test("a journal line on a job in a branch reaches the job's margin and the branch's trial balance", async ({ owner }) => {
  const branchName = `Round Rock ${run}`;
  const branch = await owner.request.post("/api/v1/business-units", { data: { name: branchName } });
  expect(branch.ok()).toBe(true);
  const branchId = (await branch.json() as { id: string }).id;

  const customerName = `Bea Books ${run}`;
  const customerId = await newCustomer(owner, {
    name: customerName, address: { street: "3 Ledger Lane", city: "Round Rock", state: "TX", zip: "78664" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const booked = await owner.request.post("/api/v1/jobs", {
    data: { customerId, propertyId, summary: `Duct work ${run}`, businessUnitId: branchId },
  });
  expect(booked.ok()).toBe(true);
  const jobId = (await booked.json() as { id: string }).id;
  const job = await (await owner.request.get(`/api/v1/jobs/${jobId}`)).json() as { number: number };

  // The form: a cost on the job, in the branch, for the customer.
  await owner.goto("/books");
  await owner.getByLabel("What it is for").fill(`Subcontractor, duct work ${run}`);
  await owner.getByLabel("Line 1 account").fill("5000");
  await owner.getByLabel("Line 1 debit").fill("325.00");
  await owner.getByLabel("Line 1 note").fill("Duct work");
  await owner.getByLabel("Line 1 branch").selectOption({ label: branchName });
  await owner.getByLabel("Line 1 job number").fill(String(job.number));
  await owner.getByLabel("Line 1 customer").fill(customerName.toLowerCase());
  await owner.getByLabel("Line 2 account").fill("1000");
  await owner.getByLabel("Line 2 credit").fill("325.00");
  await owner.getByRole("button", { name: "Post journal entry" }).click();
  await expect(owner.getByText(/Posted as journal \d+/)).toBeVisible();

  // On the journal, with the words for what it is about.
  const entry = owner.getByRole("listitem").filter({ hasText: `Subcontractor, duct work ${run}` });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(branchName);
  await expect(entry).toContainText(`job ${job.number}`);
  await expect(entry).toContainText(customerName);

  // A customer's name that matches nobody is refused against its line, and nothing is posted.
  await owner.getByLabel("What it is for").fill(`Should not post ${run}`);
  await owner.getByLabel("Line 1 account").fill("5000");
  await owner.getByLabel("Line 1 debit").fill("9.00");
  await owner.getByLabel("Line 1 customer").fill(`Nobody Of That Name ${run}`);
  await owner.getByLabel("Line 2 account").fill("1000");
  await owner.getByLabel("Line 2 credit").fill("9.00");
  await owner.getByRole("button", { name: "Post journal entry" }).click();
  await expect(owner.getByText(/Line 1: There is no customer called/)).toBeVisible();
  await owner.reload();
  await expect(owner.getByText(`Should not post ${run}`)).toHaveCount(0);

  // The job's own margin has it in materials, once, and says where it came from.
  await owner.goto(`/jobs/${jobId}`);
  const costing = owner.getByRole("region", { name: "Job costing" });
  await expect(costing).toContainText("Booked to this job by journal");
  await expect(costing).toContainText("counted in materials");
  await expect(costing.getByLabel("Journal lines on this job").getByText("$325.00")).toBeVisible();

  // The branch's trial balance has the cost, and says what it leaves out.
  await owner.goto("/books/trial-balance");
  await owner.getByLabel("Branch").selectOption({ label: branchName });
  await owner.getByRole("button", { name: "Show" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Trial balance, ${branchName}` })).toBeVisible();
  const table = owner.getByRole("table", { name: "Trial balance" });
  await expect(table.getByRole("row").filter({ hasText: "5000" })).toContainText("$325.00");
  // One side of the entry has no branch, and the report says so rather than leaving it to be found.
  await expect(owner.getByTestId("branch-coverage")).toContainText(/entries in these days carry no branch/);
  await expect(owner.getByText(/One branch.s debits and credits need not be equal/)).toBeVisible();

  // The company's own, which must balance, and which says the same about the older postings.
  await owner.goto("/books/trial-balance");
  await expect(owner.getByRole("heading", { level: 1, name: "Trial balance" })).toBeVisible();
  await expect(owner.getByText("The debits and the credits are not equal.")).toHaveCount(0);
  await expect(owner.getByText(/Anything older has none, and nothing old is changed/)).toBeVisible();
});
