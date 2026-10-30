import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A MILEAGE RATE FOR A KIND OF WORK, AND A VEHICLE ON THE DAY PAGE
 *
 * The owner gives a kind of work and a van a rate for a mile on Pay rules. Ray, on his own day, picks the
 * van on a claim in miles; the claim is worked out at the van's rate, and the office sees whose rate it was.
 */

const VAN = `Van day ${run}`;
const WORK = `Hauling ${run}`;

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
    await db.execute(sql`insert into public.job_type (organization_id, name)
      select id, ${WORK} from public.organization where slug = 'ridgeline'`);
  } finally {
    await db.$close();
  }
}

async function cleanup() {
  const db = createClient();
  try {
    await db.execute(sql`delete from public.mileage_rate_override
      where organization_id = (select id from public.organization where slug = 'ridgeline')`);
    await db.execute(sql`update public.expense set mileage_asset_id = null
      where mileage_asset_id in (select id from public.company_asset where label = ${VAN})`);
    await db.execute(sql`delete from public.company_asset where label = ${VAN}`);
    await db.execute(sql`delete from public.job_type where name = ${WORK}`);
    await db.execute(sql`
      update public.organization
         set settings = jsonb_set(settings, '{payExtras,mileageRates}', '[]'::jsonb)
       where slug = 'ridgeline' and settings #> '{payExtras}' is not null`);
  } finally {
    await db.$close();
  }
}

test("a kind of work and a van get their own rate, and Ray picks the van on his day page", async ({ owner, tech }) => {
  test.setTimeout(150_000);
  await prepare();
  try {
    const what = `Van to the yard ${run}`;
    await owner.goto("/payroll/pay-rules");
    const own = owner.getByRole("region", { name: "A mile for one person or one vehicle" });
    await own.getByLabel("Pick the kind of work").selectOption({ label: WORK });
    await own.getByLabel("Kind of work's rate starts on").fill("2025-01-01");
    await own.getByLabel("Dollars for one mile, for this kind of work").fill("0.90");
    await own.getByRole("button", { name: "Add the rate for this kind of work" }).click();
    await expect(own.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const table = own.getByRole("table", { name: "Mileage rates for one person or vehicle" });
    await expect(table.getByRole("row").filter({ hasText: WORK })).toContainText("Kind of work");
    await expect(table.getByRole("row").filter({ hasText: WORK })).toContainText("$0.900");

    await own.getByLabel("Pick the vehicle").selectOption({ label: VAN });
    await own.getByLabel("Vehicle's rate starts on").fill("2025-01-01");
    await own.getByLabel("Dollars for one mile, for this vehicle").fill("0.45");
    await own.getByRole("button", { name: "Add the rate for this vehicle" }).click();
    await expect(table).toContainText(VAN);

    await tech.goto("/my-day");
    const panel = tech.getByRole("region", { name: "Money I spent" });
    await panel.getByRole("button", { name: "Add one" }).click();
    await expect(panel.getByText("A job whose kind of work has its own rate is paid at that rate.")).toBeVisible();
    await panel.getByLabel("Or the miles you drove").fill("10");
    await panel.getByLabel("Which vehicle (if it has its own rate)").selectOption({ label: `${VAN}, $0.450 a mile` });
    await panel.getByLabel("What it was for").fill(what);
    await panel.getByRole("button", { name: "Save it" }).click();
    await expect(panel.getByRole("status")).toContainText("Saved.");
    await expect(tech.getByText(/All sent/)).toBeVisible();

    await owner.goto("/timesheets/expenses");
    const row = owner.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: what });
    await expect(row).toContainText("$4.50");
    await expect(row).toContainText(`the rate for ${VAN}`);
  } finally {
    await cleanup();
  }
});
