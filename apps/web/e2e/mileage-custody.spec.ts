import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * THE VEHICLE CHECKED OUT TO A PERSON PICKS THE MILEAGE RATE
 *
 * A van with a rate of its own is checked out to Ray. His claim in miles that
 * names no vehicle is worked out at the van's rate and says it was the vehicle
 * checked out to him that day; saying it was his own car is worked out at the
 * company's rate and still names the van, and the office sees both.
 */

const VAN = `Van checked out ${run}`;

async function prepare() {
  const db = createClient();
  try {
    await db.execute(sql`
      update public.organization
         set settings = settings || jsonb_build_object('payExtras',
               coalesce(settings -> 'payExtras', '{}'::jsonb)
               || jsonb_build_object('mileageRates', jsonb_build_array(jsonb_build_object('from', '2025-01-01', 'perMile', '0.700'))))
       where slug = 'ridgeline'`);
    await db.execute(sql`
      with org as (select id from public.organization where slug = 'ridgeline'),
           van as (
             insert into public.company_asset (organization_id, kind, label)
             select id, 'vehicle', ${VAN} from org returning id, organization_id
           ),
           rate as (
             insert into public.mileage_rate_override (organization_id, asset_id, from_day, per_mile)
             select organization_id, id, '2025-01-01', '0.450' from van returning asset_id
           )
      insert into public.asset_custody (organization_id, asset_id, custodian_kind, custodian_id, held_from)
      select van.organization_id, van.id, 'technician',
             (select t.id from public.technician t where t.organization_id = van.organization_id and t.display_name = 'Ray Ortiz' limit 1),
             '2025-01-01'
      from van`);
  } finally {
    await db.$close();
  }
}

async function cleanup() {
  const db = createClient();
  try {
    await db.execute(sql`delete from public.asset_custody where asset_id in (select id from public.company_asset where label = ${VAN})`);
    await db.execute(sql`delete from public.mileage_rate_override where asset_id in (select id from public.company_asset where label = ${VAN})`);
    await db.execute(sql`update public.expense set mileage_asset_id = null where mileage_asset_id in (select id from public.company_asset where label = ${VAN})`);
    await db.execute(sql`delete from public.company_asset where label = ${VAN}`);
    await db.execute(sql`
      update public.organization
         set settings = jsonb_set(settings, '{payExtras,mileageRates}', '[]'::jsonb)
       where slug = 'ridgeline' and settings #> '{payExtras}' is not null`);
  } finally {
    await db.$close();
  }
}

test("a claim in miles is worked out at the vehicle checked out that day, unless the person says otherwise", async ({ owner, tech }) => {
  test.setTimeout(150_000);
  await prepare();
  try {
    const inVan = `Drive, nothing picked ${run}`;
    const inCar = `Drive in my own car ${run}`;

    await tech.goto("/me/expenses");
    await expect(tech.getByText(`You have ${VAN} checked out today.`)).toBeVisible();

    await tech.getByLabel("Or the miles you drove").fill("10");
    await tech.getByLabel("What it was for").fill(inVan);
    await tech.getByRole("button", { name: "Save it" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const vanClaim = tech.getByRole("listitem").filter({ hasText: inVan });
    await expect(vanClaim).toContainText("$4.50");
    await expect(vanClaim).toContainText(`10.0 miles at $0.450 a mile, the rate for ${VAN}, which was checked out to you that day`);

    await tech.getByLabel("Or the miles you drove").fill("10");
    await tech.getByLabel("Which vehicle (if it has its own rate)").selectOption({ label: "My own vehicle" });
    await tech.getByLabel("What it was for").fill(inCar);
    await tech.getByRole("button", { name: "Save it" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const carClaim = tech.getByRole("listitem").filter({ hasText: inCar });
    await expect(carClaim).toContainText("$7.00");
    await expect(carClaim).toContainText(`${VAN} was checked out to you that day but was not what the claim says was driven`);

    await owner.goto("/timesheets/expenses");
    const rows = owner.getByRole("table", { name: "Expenses" }).getByRole("row");
    await expect(rows.filter({ hasText: inVan })).toContainText(`the rate for ${VAN}, which was checked out to Ray Ortiz that day`);
    await expect(rows.filter({ hasText: inCar })).toContainText(`${VAN} was checked out to Ray Ortiz that day`);
  } finally {
    await cleanup();
  }
});
