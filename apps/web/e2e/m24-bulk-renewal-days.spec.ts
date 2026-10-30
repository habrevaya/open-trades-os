import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, companyToday } from "./fixtures";

/**
 * DAYS AHEAD FOR SEVERAL CARDS AT ONCE (M24)
 *
 * The office ticks the cards that need a longer warning and sets the number once. A blank box hands
 * them all back to their kind's number.
 */
function companyDay(days: number): string {
  const [y, m, d] = companyToday().split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

test("the office sets the days ahead on several ticked cards at once, and hands them back", async ({ owner }) => {
  test.setTimeout(120_000);
  const kind = `Scaffold ticket ${run}`;
  const people = [`Bulk Bea ${run}`, `Bulk Cy ${run}`];
  const db = createClient();
  const created: { user: string; member: string; tech: string }[] = [];
  const [org] = await db.execute<{ id: string }>(sql`select id from public.organization where slug = 'ridgeline'`);
  const [type] = await db.execute<{ id: string }>(sql`
    insert into public.certification_type (organization_id, code, name, renewal_lead_days)
    values (${org!.id}, ${`SC${run.slice(-8).toUpperCase()}`}, ${kind}, 60) returning id`);
  for (const name of people) {
    const [user] = await db.execute<{ id: string }>(sql`insert into public."user" (email, name)
      values (${`${name.replace(/\s/g, "-").toLowerCase()}@e2e.test`}, ${name}) returning id`);
    const [member] = await db.execute<{ id: string }>(sql`
      insert into public.membership (organization_id, user_id, role) values (${org!.id}, ${user!.id}, 'technician') returning id`);
    const [tech] = await db.execute<{ id: string }>(sql`insert into public.technician (organization_id, membership_id, display_name)
      values (${org!.id}, ${member!.id}, ${name}) returning id`);
    await db.execute(sql`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on, status)
      values (${org!.id}, ${tech!.id}, ${type!.id}, ${companyDay(200)}, 'active')`);
    created.push({ user: user!.id, member: member!.id, tech: tech!.id });
  }
  try {
    await owner.goto("/certifications");
    const held = (name: string) => owner.getByRole("listitem").filter({ hasText: kind }).filter({ hasText: "Until" })
      .filter({ has: owner.getByLabel(`Tick ${kind} for ${name}`) });

    await expect(held(people[0]!)).toContainText("Told 60 days ahead, as for every one of this kind.");
    const bulk = owner.locator("#bulk-renewal-days");

    // Nothing ticked is refused in words.
    await bulk.getByLabel("Days ahead for the ticked cards").fill("250");
    await bulk.getByRole("button", { name: "Set days ahead on the ticked cards" }).click();
    await expect(bulk.getByRole("alert")).toContainText("Tick at least one card");

    // A word is refused, and nothing changes.
    await owner.getByLabel(`Tick ${kind} for ${people[0]}`).check();
    await owner.getByLabel(`Tick ${kind} for ${people[1]}`).check();
    await bulk.getByLabel("Days ahead for the ticked cards").fill("soon");
    await bulk.getByRole("button", { name: "Set days ahead on the ticked cards" }).click();
    await expect(bulk.getByRole("alert")).toContainText("whole number of days");
    await expect(held(people[0]!)).toContainText("Told 60 days ahead");

    // Two cards, one number.
    await bulk.getByLabel("Days ahead for the ticked cards").fill("250");
    await bulk.getByRole("button", { name: "Set days ahead on the ticked cards" }).click();
    await expect(bulk.getByRole("status")).toContainText("2 cards now warn 250 days ahead");
    await expect(held(people[0]!)).toContainText("Told 250 days ahead, set for this card.");
    await expect(held(people[1]!)).toContainText("Told 250 days ahead, set for this card.");

    // A blank box hands the ticked ones back to the kind's number.
    await owner.getByLabel(`Tick ${kind} for ${people[0]}`).check();
    await bulk.getByLabel("Days ahead for the ticked cards").fill("");
    await bulk.getByRole("button", { name: "Set days ahead on the ticked cards" }).click();
    await expect(bulk.getByRole("status")).toContainText("1 card now follows its kind's number");
    await expect(held(people[0]!)).toContainText("Told 60 days ahead, as for every one of this kind.");
    await expect(held(people[1]!)).toContainText("Told 250 days ahead, set for this card.");
  } finally {
    for (const c of created) await db.execute(sql`delete from public.person_certification where technician_id = ${c.tech}`);
    await db.execute(sql`delete from public.certification_type where id = ${type!.id}`);
    for (const c of created) {
      await db.execute(sql`delete from public.technician where id = ${c.tech}`);
      await db.execute(sql`delete from public.membership where id = ${c.member}`);
      await db.execute(sql`delete from public."user" where id = ${c.user}`);
    }
    await db.$close();
  }
});
