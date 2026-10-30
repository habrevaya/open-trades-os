import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A MILEAGE RATE OF ONE PERSON'S OR ONE VEHICLE'S OWN
 *
 * The owner gives Ray a rate and a van a rate on Pay rules. Ray's claim in miles is worked out at his
 * own rate, or at the van's when he names it, and the claim and the office's list say whose rate it was.
 */

const VAN = `Van mileage ${run}`;

async function prepare() {
  const db = createClient();
  try {
    await db.execute(sql`delete from public.mileage_rate_override
      where organization_id = (select id from public.organization where slug = 'ridgeline')`);
    await db.execute(sql`
      update public.organization
         set settings = settings || jsonb_build_object('payExtras',
               coalesce(settings -> 'payExtras', '{}'::jsonb)
               || jsonb_build_object('mileageRates', jsonb_build_array(jsonb_build_object('from', '2025-01-01', 'perMile', '0.700'))))
       where slug = 'ridgeline'`);
    await db.execute(sql`insert into public.company_asset (organization_id, kind, label)
      select id, 'vehicle', ${VAN} from public.organization where slug = 'ridgeline'`);
  } finally {
    await db.$close();
  }
}

async function cleanup() {
  const db = createClient();
  try {
    await db.execute(sql`delete from public.mileage_rate_override
      where organization_id = (select id from public.organization where slug = 'ridgeline')`);
    await db.execute(sql`delete from public.company_asset where label = ${VAN}`);
    await db.execute(sql`
      update public.organization
         set settings = jsonb_set(settings, '{payExtras,mileageRates}', '[]'::jsonb)
       where slug = 'ridgeline' and settings #> '{payExtras}' is not null`);
  } finally {
    await db.$close();
  }
}

test("the owner sets a rate for a person and a vehicle, and a claim says whose rate it was worked out at", async ({ owner, tech }) => {
  test.setTimeout(150_000);
  await prepare();
  try {
    const ownRate = `Drive in my own car ${run}`;
    const vanRate = `Drive in the van ${run}`;

    // With only the company's rate, there is no vehicle to pick.
    await tech.goto("/me/expenses");
    await expect(tech.getByText("Miles are paid at $0.700 a mile")).toBeVisible();
    await expect(tech.getByLabel("Which vehicle (if it has its own rate)")).toHaveCount(0);

    // The owner gives Ray a rate and the van a rate.
    await owner.goto("/payroll/pay-rules");
    const own = owner.getByRole("region", { name: "A mile for one person or one vehicle" });
    await own.getByLabel("Pick the person").selectOption({ label: "Ray Ortiz" });
    await own.getByLabel("Person's rate starts on").fill("2025-01-01");
    await own.getByLabel("Dollars for one mile, for this person").fill("seventy cents");
    await own.getByRole("button", { name: "Add the rate for this person" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "dollars" })).toBeVisible();
    await own.getByLabel("Dollars for one mile, for this person").fill("0.80");
    await own.getByRole("button", { name: "Add the rate for this person" }).click();
    await expect(own.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const table = own.getByRole("table", { name: "Mileage rates for one person or vehicle" });
    await expect(table).toContainText("Ray Ortiz");
    await expect(table).toContainText("$0.800");
    // A day cannot have two for the same person.
    await own.getByLabel("Pick the person").selectOption({ label: "Ray Ortiz" });
    await own.getByLabel("Person's rate starts on").fill("2025-01-01");
    await own.getByLabel("Dollars for one mile, for this person").fill("0.90");
    await own.getByRole("button", { name: "Add the rate for this person" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "There is already a rate from" })).toBeVisible();

    await own.getByLabel("Pick the vehicle").selectOption({ label: VAN });
    await own.getByLabel("Vehicle's rate starts on").fill("2025-01-01");
    await own.getByLabel("Dollars for one mile, for this vehicle").fill("0.45");
    await own.getByRole("button", { name: "Add the rate for this vehicle" }).click();
    await expect(table).toContainText(VAN);
    await expect(table).toContainText("$0.450");

    // Ray's claim without a vehicle is at his own rate; with the van it is at the van's.
    await tech.reload();
    await expect(tech.getByText("Miles are paid at $0.800 a mile")).toBeVisible();
    await tech.getByLabel("Or the miles you drove").fill("10");
    await tech.getByLabel("What it was for").fill(ownRate);
    await tech.getByRole("button", { name: "Save it" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const mineOwn = tech.getByRole("listitem").filter({ hasText: ownRate });
    await expect(mineOwn).toContainText("$8.00");
    await expect(mineOwn).toContainText("10.0 miles at $0.800 a mile, your own rate");

    await tech.getByLabel("Or the miles you drove").fill("10");
    await tech.getByLabel("Which vehicle (if it has its own rate)").selectOption({ label: `${VAN}, $0.450 a mile` });
    await tech.getByLabel("What it was for").fill(vanRate);
    await tech.getByRole("button", { name: "Save it" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const mineVan = tech.getByRole("listitem").filter({ hasText: vanRate });
    await expect(mineVan).toContainText("$4.50");
    await expect(mineVan).toContainText(`10.0 miles at $0.450 a mile, the rate for ${VAN}`);

    // The office sees whose rate each was.
    await owner.goto("/timesheets/expenses");
    const rows = owner.getByRole("table", { name: "Expenses" }).getByRole("row");
    await expect(rows.filter({ hasText: ownRate })).toContainText("Ray Ortiz's rate");
    await expect(rows.filter({ hasText: vanRate })).toContainText(`the rate for ${VAN}`);

    // Taking a line off leaves the claim as it was worked out.
    await owner.goto("/payroll/pay-rules");
    await owner.getByRole("button", { name: /^Take off the rate for Ray Ortiz from/ }).click();
    await expect(owner.getByRole("table", { name: "Mileage rates for one person or vehicle" })).not.toContainText("Ray Ortiz");
    await tech.goto("/me/expenses");
    await expect(tech.getByText("Miles are paid at $0.700 a mile")).toBeVisible();
    await expect(tech.getByRole("listitem").filter({ hasText: ownRate })).toContainText("$8.00");
  } finally {
    await cleanup();
  }
});
