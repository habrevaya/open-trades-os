import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * THE CANCELLATION RATE MONTH BY MONTH
 *
 * Cleaning's cancellation rate by route, shown a month at a time. The seeded
 * company is HVAC, so this spec makes it a cleaning company for the length of
 * one test (the suite runs one test at a time) and puts it back, and puts three
 * stops on a route of its own in a January and a February long before the
 * seed's own work.
 */

test("Trade scorecard: the cancellation rate month by month, each half opening that month's stops", async ({ owner }) => {
  const route = `Series North ${run}`;
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
        select o.id, ${`Recurring clean ${run}`}, ${`ss-${run}`}, 'route', 'recurring' from o returning id
      ),
      c as (select customer_id, property_id from public.job where organization_id = (select id from o) limit 1),
      n as (select coalesce(max(number), 0) as top from public.job where organization_id = (select id from o)),
      j as (
        insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
        select o.id, n.top + s, c.customer_id, c.property_id, t.id, 'scheduled', ${`Series stop ${run}`} || ' ' || s
        from o, n, c, t, generate_series(1, 3) as s
        returning id, number
      ),
      -- Two stops on 2023-01-09 (the second called off late by the customer) and one on 2023-02-06 (kept).
      d as (
        select j.id as job_id, j.number, n.top,
               case when j.number = n.top + 3 then '2023-02-06' else '2023-01-09' end as day
        from j, n
      )
      insert into public.visit (organization_id, job_id, status, window_start, window_end, route_id,
                                cancelled_by, cancelled_at, cancel_notice_hours)
      select o.id, d.job_id,
             case when d.number = d.top + 2 then 'cancelled' else 'scheduled' end::visit_status,
             ((d.day || ' 09:00')::timestamp at time zone o.timezone), ((d.day || ' 11:00')::timestamp at time zone o.timezone),
             r.id,
             case when d.number = d.top + 2 then 'customer' end::visit_cancelled_by,
             case when d.number = d.top + 2 then ((d.day || ' 07:00')::timestamp at time zone o.timezone) end,
             case when d.number = d.top + 2 then 24 end
      from o, d, r`);

    await owner.goto("/reports/scorecard?from=2023-02-01&to=2023-02-28");
    const card = owner.getByRole("listitem").filter({ hasText: "Cancellation rate by route" });
    await card.getByLabel("Break it down by").selectOption({ label: "Route" });
    await card.getByLabel("Over time").selectOption({ label: "Month by month, the last 6" });
    await card.getByRole("button", { name: "Show" }).click();
    await expect(owner).toHaveURL(/kpi=cancel_rate_route&by=route&months=6/);

    const table = owner.getByRole("table", { name: "Cancellation rate by route by route, month by month" });
    await expect(table.getByRole("columnheader", { name: /Jan 2023/ })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: /Feb 2023/ })).toBeVisible();
    // Six months up to the end of February, oldest first: Sep to Feb.
    await expect(table.getByRole("columnheader", { name: /Sep 2022/ })).toBeVisible();
    const row = table.getByRole("row").filter({ hasText: route });
    // January: one of two stops called off late. February: none of one. A month with no stops reads "None".
    await expect(row.getByRole("cell").nth(5)).toContainText("50.0%");
    await expect(row.getByRole("cell").nth(5)).toContainText("1 of 2");
    await expect(row.getByRole("cell").nth(6)).toContainText("0.0%");
    await expect(row.getByRole("cell").nth(1)).toContainText("None");
    await expect(row.getByRole("cell").nth(7)).toContainText("1 of 3");

    // January's two stops open from the cell, and they add up to it.
    await row.getByRole("cell").nth(5).getByRole("link", { name: "2", exact: true }).click();
    await expect(owner).toHaveURL(/from=2023-01-01&to=2023-01-31/);
    await expect(owner).toHaveURL(/by=route&group=route%3A/);
    await expect(owner.getByRole("row", { name: /Total/ })).toContainText("2");
    await expect(owner.getByRole("table").getByRole("link", { name: new RegExp(`${route}, Monday`) })).toHaveCount(2);
  } finally {
    await db.execute(sql`update public.organization set primary_trade = ${trade} where slug = 'ridgeline'`);
    await db.$close();
  }
});

test("Trade scorecard: only the figure that can be shown by month offers it", async ({ owner }) => {
  const db = createClient();
  let trade: string | null = null;
  try {
    const [org] = await db.execute<{ primary_trade: string | null }>(sql`
      select primary_trade from public.organization where slug = 'ridgeline'`);
    trade = org?.primary_trade ?? null;
    await db.execute(sql`update public.organization set primary_trade = 'cleaning' where slug = 'ridgeline'`);
    await owner.goto("/reports/scorecard?from=2023-02-01&to=2023-02-28");
    const card = owner.getByRole("listitem").filter({ hasText: "Cancellation rate by route" });
    await expect(card.getByLabel("Over time")).toBeVisible();
    // A figure that cannot be shown by month has no such choice anywhere on the page.
    const others = owner.getByRole("listitem").filter({ hasNotText: "Cancellation rate by route" });
    await expect(others.getByLabel("Over time")).toHaveCount(0);
  } finally {
    await db.execute(sql`update public.organization set primary_trade = ${trade} where slug = 'ridgeline'`);
    await db.$close();
  }
});
