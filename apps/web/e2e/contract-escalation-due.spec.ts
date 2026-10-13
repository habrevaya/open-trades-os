import { createClient, schema } from "@opentradesos/db";
import { contractEscalation } from "@opentradesos/api/services";
import { eq } from "drizzle-orm";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CONTRACT'S YEARLY RISE COMING DUE, AND A PERSON APPLYING IT
 *
 * A contract set up a year ago less twenty days, rising 3% a year, with one
 * card. The worker's pass (run here as the worker runs it) prepares next
 * year's card as a draft and raises a task in the office queue. The contract
 * says the draft is ready and that nothing changes until somebody applies it;
 * the person applies it, and the draft note and the task's button go.
 */
async function workerPass(contractId: string) {
  const db = createClient();
  try {
    const [row] = await db.select({ organizationId: schema.serviceContract.organizationId })
      .from(schema.serviceContract).where(eq(schema.serviceContract.id, contractId)).limit(1);
    if (!row) throw new Error(`No contract ${contractId}`);
    return await contractEscalation.noticesFor(db, row.organizationId);
  } finally {
    await db.$close();
  }
}

test("a contract's rise is prepared as a draft and a task thirty days ahead, and applied by a person", async ({ owner }) => {
  const today = companyToday();
  const anniversary = new Date(Date.parse(`${today}T12:00:00Z`) + 20 * 864e5).toISOString().slice(0, 10);
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
  const name = `Harbor upkeep ${run}`;

  const clientId = await newCustomer(owner, { name: `Harbor Offices ${run}`, phone: "+15125550291" });
  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(name);
  await owner.getByLabel("Starts").fill(startsOn);
  await owner.getByLabel("Rates rise each year by, per cent").fill("3");
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
  const contractUrl = owner.url();
  const contractId = contractUrl.split("/").pop()!;

  await owner.getByText("Add a rate card").click();
  await owner.getByLabel("Name", { exact: true }).last().fill("Harbor schedule");
  await owner.getByLabel("In force from").fill(startsOn);
  await owner.getByRole("button", { name: "Add the card" }).click();
  await expect(owner.getByRole("heading", { name: "Harbor schedule" })).toBeVisible();

  const result = await workerPass(contractId);
  expect(result.raised).toEqual([contractId]);

  await owner.reload();
  const rise = owner.getByRole("region", { name: "Annual escalation" });
  const note = rise.getByRole("note", { name: "Draft prices" });
  await expect(note).toContainText("Year 2 prices are ready as a draft");
  await expect(note).toContainText("Harbor schedule (year 2)");
  await expect(note).toContainText("Nothing changes until somebody presses");
  // The draft is not one of the contract's cards.
  await expect(owner.getByRole("heading", { name: "Harbor schedule (year 2)" })).toHaveCount(0);

  await owner.goto("/tasks");
  await expect(owner.getByText(`Year 2 prices for ${name} are due on ${anniversary}`)).toBeVisible();

  await owner.goto(contractUrl);
  await rise.getByRole("button", { name: "Apply year 2 prices" }).click();
  await expect(rise.getByRole("status")).toContainText(`risen from ${anniversary}`);
  await owner.reload();
  await expect(owner.getByRole("heading", { name: "Harbor schedule (year 2)" })).toBeVisible();
  await expect(owner.getByRole("note", { name: "Draft prices" })).toHaveCount(0);
});
