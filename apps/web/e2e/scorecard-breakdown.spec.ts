import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A SCORECARD FIGURE BROKEN DOWN BY WHAT ITS RECORDS SAY
 *
 * Cleaning's cancellation rate is "reported per route and per weekday", and
 * every stop behind it names both. The seeded company is HVAC, so this spec
 * makes it a cleaning company for the length of one test (the suite runs one
 * test at a time) and puts it back, and puts two stops on a route of its own
 * in a February long before the seed's own work.
 */

test("Trade scorecard: the cancellation rate broken down by route, each half opening that route's stops", async ({ owner }) => {
  const route = `Breakdown North ${run}`;
  const db = createClient();
  let trade: string | null = null;
  try {
    const [org] = await db.execute<{ primary_trade: string | null }>(sql`
      select primary_trade from public.organization where slug = 'ridgeline'`);
    trade = org?.primary_trade ?? null;
    await db.execute(sql`update public.organization set primary_trade = 'cleaning' where slug = 'ridgeline'`);
    await db.execute(sql`
      with o as (select id, timezone from public.organization where slug = 'ridgeline'),
      r as (insert into public.route (organization_id, name, day_of_week) select o.id, ${route}, 1 from o returning id),
      t as (
        insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
        select o.id, ${`Recurring clean ${run}`}, ${`bd-${run}`}, 'route', 'recurring' from o returning id
      ),
      c as (select customer_id, property_id from public.job where organization_id = (select id from o) limit 1),
      n as (select coalesce(max(number), 0) as top from public.job where organization_id = (select id from o)),
      j as (
        insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
        select o.id, n.top + s, c.customer_id, c.property_id, t.id, 'scheduled', ${`Breakdown stop ${run}`} || ' ' || s
        from o, n, c, t, generate_series(1, 2) as s
        returning id, number
      )
      insert into public.visit (organization_id, job_id, status, window_start, window_end, route_id,
                                cancelled_by, cancelled_at, cancel_notice_hours)
      select o.id, j.id,
             case when j.number = n.top + 2 then 'cancelled' else 'scheduled' end::visit_status,
             ('2024-02-05 09:00'::timestamp at time zone o.timezone), ('2024-02-05 11:00'::timestamp at time zone o.timezone),
             r.id,
             case when j.number = n.top + 2 then 'customer' end::visit_cancelled_by,
             case when j.number = n.top + 2 then ('2024-02-05 07:00'::timestamp at time zone o.timezone) end,
             case when j.number = n.top + 2 then 24 end
      from o, j, n, r`);

    await owner.goto("/reports/scorecard?from=2024-02-01&to=2024-02-29");
    const card = owner.getByRole("listitem").filter({ hasText: "Cancellation rate by route" });
    await card.getByLabel("Break it down by").selectOption({ label: "Route" });
    await card.getByRole("button", { name: "Show" }).click();
    await expect(owner).toHaveURL(/kpi=cancel_rate_route&by=route/);

    const table = owner.getByRole("table", { name: "Cancellation rate by route by route" });
    const row = table.getByRole("row").filter({ hasText: route });
    await expect(row).toContainText("50.0%");

    // The bottom half of that route opens its two stops, and they add up to it.
    await row.getByRole("link", { name: "2", exact: true }).click();
    await expect(owner).toHaveURL(/by=route&group=route%3A/);
    await expect(owner.getByText(`route ${route}`)).toBeVisible();
    await expect(owner.getByRole("row", { name: /Total/ })).toContainText("2");
    // Each stop is named with its route and weekday.
    await expect(owner.getByRole("table").getByRole("link", { name: new RegExp(`${route}, Monday`) })).toHaveCount(2);
  } finally {
    await db.execute(sql`update public.organization set primary_trade = ${trade} where slug = 'ridgeline'`);
    await db.$close();
  }
});
