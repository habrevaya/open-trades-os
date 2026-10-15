import { createClient, schema } from "@opentradesos/db";
import { contractEscalation } from "@opentradesos/api/services";
import { eq } from "drizzle-orm";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CONTRACT'S FIXED FEE RISING WITH ITS YEARLY RISE
 *
 * A contract set up a year ago less three or four weeks, rising 3% a year,
 * billed 1,200.00 a month from its anniversary. The office ticks that the
 * fee rises with the yearly rise; the contract then shows the fee at
 * 1,236.00 from the anniversary beside next year's prices, the worker's pass
 * (run here as the worker runs it) prepares it in the draft, and a person
 * applying year 2's prices makes it the fee from the anniversary.
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

/** An anniversary three to four weeks away on a day of the month a fee can be billed on (1 to 28). */
function anniversaryAhead(): string {
  const today = companyToday();
  for (let days = 21; days <= 30; days += 1) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
    if (Number(date.slice(8, 10)) <= 28) return date;
  }
  throw new Error("No anniversary three to four weeks ahead falls on day 28 or before.");
}

test("a contract's fixed fee rises with its yearly rise when the office says so, applied by a person", async ({ owner }) => {
  test.setTimeout(180_000);
  const anniversary = anniversaryAhead();
  const startsOn = `${Number(anniversary.slice(0, 4)) - 1}${anniversary.slice(4)}`;
  const name = `Pier upkeep ${run}`;

  const clientId = await newCustomer(owner, { name: `Pier Offices ${run}`, phone: "+15125550327" });
  await owner.goto(`/contracts/new?customer=${clientId}`);
  await owner.getByLabel("Name", { exact: true }).fill(name);
  await owner.getByLabel("Starts").fill(startsOn);
  await owner.getByLabel("Rates rise each year by, per cent").fill("3");
  await owner.getByRole("button", { name: "Set up the contract" }).click();
  await expect(owner).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
  const contractUrl = owner.url();
  const contractId = contractUrl.split("/").pop()!;

  const fee = owner.getByRole("region", { name: "Billed on a schedule" });
  await fee.getByLabel("Fee each time").fill("1200.00");
  await fee.getByLabel("Billing day of the month (1 to 28)").fill(String(Number(anniversary.slice(8, 10))));
  await fee.getByLabel("First day billed for").fill(anniversary);
  await fee.getByLabel("What the invoice says").fill("Planned maintenance, the pier");
  await fee.getByLabel(/The fee rises with the contract/).check();
  await fee.getByRole("button", { name: "Save the fee" }).click();
  await expect(fee).toContainText("The fee rises with the contract's yearly rise, when a person applies it.");

  await owner.reload();
  const rise = owner.getByRole("region", { name: "Annual escalation" });
  const table = rise.getByRole("table", { name: `Fixed fee from ${anniversary}` });
  await expect(table).toContainText("1,200.00");
  await expect(table).toContainText("1,236.00");
  await expect(table).toContainText("The contract's yearly rate");

  const result = await workerPass(contractId);
  expect(result.raised).toEqual([contractId]);
  await owner.reload();
  await expect(rise.getByRole("note", { name: "Draft fee" })).toContainText("1,236.00");

  await rise.getByRole("button", { name: "Apply year 2 prices" }).click();
  await expect(rise).toContainText(`Last risen on ${anniversary}.`);
  await owner.reload();
  await expect(fee).toContainText(`From ${anniversary} the fee is`);
  await expect(fee).toContainText("1,236.00");
  await expect(rise.getByRole("note", { name: "Draft fee" })).toHaveCount(0);
});
