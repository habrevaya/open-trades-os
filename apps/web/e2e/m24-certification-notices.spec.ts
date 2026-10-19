import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, companyToday } from "./fixtures";

/**
 * A LICENCE RUNNING OUT, FROM THE OFFICE'S SIDE (M24)
 *
 * One card is given a number of days ahead of its own, and the renewals list
 * and the words under it follow; several people are named to keep the list and
 * one is taken off; and a person turns the email for a licence running out off
 * on their own page. The worker's side (who is emailed, once) is pinned in the
 * integration test against the outbox; this is what a person at the keyboard
 * can see and do.
 */

/** A date `days` from the company's today, as the database takes it. */
function companyDay(days: number): string {
  const [y, m, d] = companyToday().split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

test("a card is warned from a number of days of its own, and goes back to its kind's number", async ({ owner }) => {
  const name = `Cert Carl ${run}`;
  const kind = `Hoist ticket ${run}`;
  const email = `cert-carl-${run}@e2e.test`;
  const db = createClient();
  const [user] = await db.execute<{ id: string }>(sql`insert into public."user" (email, name) values (${email}, ${name}) returning id`);
  const [member] = await db.execute<{ id: string; organization_id: string }>(sql`
    insert into public.membership (organization_id, user_id, role)
    select id, ${user!.id}, 'technician' from public.organization where slug = 'ridgeline' returning id, organization_id`);
  const [tech] = await db.execute<{ id: string }>(sql`insert into public.technician (organization_id, membership_id, display_name)
    values (${member!.organization_id}, ${member!.id}, ${name}) returning id`);
  const [type] = await db.execute<{ id: string }>(sql`
    insert into public.certification_type (organization_id, code, name, renewal_lead_days)
    values (${member!.organization_id}, ${`HT${run.slice(-8).toUpperCase()}`}, ${kind}, 60) returning id`);
  await db.execute(sql`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on, status)
    values (${member!.organization_id}, ${tech!.id}, ${type!.id}, ${companyDay(200)}, 'active')`);
  try {
    await owner.goto("/certifications");
    const holding = owner.getByRole("listitem").filter({ hasText: kind }).filter({ hasText: "Until" });
    await expect(holding).toContainText("Told 60 days ahead, as for every one of this kind.");
    // 200 days away is outside the kind's 60, so it is not on the list of what is due.
    await expect(owner.getByRole("listitem").filter({ hasText: kind }).filter({ hasText: "days left" })).toHaveCount(0);

    const days = holding.getByLabel(`Days ahead to warn about ${kind} for ${name}`);
    await days.fill("soon");
    await holding.getByRole("button", { name: "Change days ahead" }).click();
    await expect(holding.getByRole("alert").filter({ hasText: "whole number of days" })).toBeVisible();

    await days.fill("250");
    await holding.getByRole("button", { name: "Change days ahead" }).click();
    await expect(holding).toContainText("Told 250 days ahead, set for this card.");
    await expect(owner.getByRole("listitem").filter({ hasText: kind }).filter({ hasText: "200 days left" })).toHaveCount(1);

    // It is the card's own, so changing the kind's number does not move it, and the API says both.
    const read = await owner.request.get(`/api/v1/certifications?technicianId=${tech!.id}`);
    const body = (await read.json()) as { certifications: { renewalLeadDays: number; ownRenewalLeadDays: number | null }[] };
    expect(body.certifications[0]).toMatchObject({ renewalLeadDays: 250, ownRenewalLeadDays: 250 });

    await days.fill("");
    await holding.getByRole("button", { name: "Change days ahead" }).click();
    await expect(holding).toContainText("Told 60 days ahead, as for every one of this kind.");
    await expect(owner.getByRole("listitem").filter({ hasText: kind }).filter({ hasText: "days left" })).toHaveCount(0);
  } finally {
    await db.execute(sql`delete from public.person_certification where technician_id = ${tech!.id}`);
    await db.execute(sql`delete from public.certification_type where id = ${type!.id}`);
    await db.execute(sql`delete from public.technician where id = ${tech!.id}`);
    await db.execute(sql`delete from public.membership where id = ${member!.id}`);
    await db.execute(sql`delete from public."user" where id = ${user!.id}`);
    await db.$close();
  }
});

test("the owner names two people to keep the renewals list, takes one off, and then nobody", async ({ owner }) => {
  const name = `Kee Per ${run}`;
  const email = `kee-per-${run}@e2e.test`;
  const db = createClient();
  const [user] = await db.execute<{ id: string }>(sql`insert into public."user" (email, name) values (${email}, ${name}) returning id`);
  await db.execute(sql`
    insert into public.membership (organization_id, user_id, role)
    select id, ${user!.id}, 'owner' from public.organization where slug = 'ridgeline'`);
  try {
    await owner.goto("/certifications");
    const keeper = owner.getByRole("region", { name: "Who keeps this list" });
    await expect(keeper).toContainText("Nobody else is told.");

    const choice = keeper.getByLabel("Also tell");
    await choice.selectOption({ label: name });
    await keeper.getByRole("button", { name: "Save", exact: true }).click();
    await expect(keeper.getByRole("status").filter({ hasText: `Saved. ${name} will be told` })).toBeVisible();
    await expect(keeper).toContainText(`${name} is told as well, because they keep this list.`);

    // A second person: whoever else the list offers, other than the one already named.
    const other = await choice.locator("option").nth(1).textContent();
    expect(other).toBeTruthy();
    expect(other).not.toBe(name);
    await choice.selectOption({ label: other! });
    await keeper.getByRole("button", { name: "Save", exact: true }).click();
    await expect(keeper).toContainText("are told as well, because they keep this list.");
    await expect(keeper).toContainText(name);
    await expect(keeper).toContainText(other!);
    const both = await owner.request.get("/api/v1/certification-renewals/keepers");
    expect(((await both.json()) as { keepers: unknown[] }).keepers).toHaveLength(2);

    // Choosing nobody in the list does nothing but say so.
    await choice.selectOption({ label: "Choose someone" });
    await keeper.getByRole("button", { name: "Save", exact: true }).click();
    await expect(keeper.getByRole("alert").filter({ hasText: "Choose someone to tell" })).toBeVisible();

    await keeper.getByRole("button", { name: `Stop telling ${name}` }).click();
    await expect(keeper).toContainText(`${other} is told as well, because they keep this list.`);
    await expect(keeper.getByRole("button", { name: `Stop telling ${name}` })).toHaveCount(0);

    await choice.selectOption({ label: "Nobody else" });
    await keeper.getByRole("button", { name: "Save", exact: true }).click();
    await expect(keeper).toContainText("Nobody else is told.");
  } finally {
    await db.execute(sql`delete from public.certification_renewals_keeper where user_id = ${user!.id}`);
    await db.execute(sql`delete from public.membership where user_id = ${user!.id}`);
    await db.execute(sql`delete from public."user" where id = ${user!.id}`);
    await db.$close();
  }
});

test("a person turns the email for a licence running out off on their own page, and back on", async ({ owner }) => {
  await owner.goto("/me");
  const section = owner.locator("#notices");
  const box = section.getByRole("checkbox", { name: "A licence or skill running out: by email" });
  await expect(box).toBeChecked();
  // A kind nothing emails has no such box.
  await expect(section.getByRole("checkbox", { name: "A late task: by email" })).toHaveCount(0);

  await box.uncheck();
  await section.getByRole("button", { name: "Save what I am told" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.reload();
  await expect(owner.locator("#notices").getByRole("checkbox", { name: "A licence or skill running out: by email" })).not.toBeChecked();
  const read = await owner.request.get("/api/v1/me/notice-settings");
  const kinds = ((await read.json()) as { kinds: { kind: string; email: boolean | null }[] }).kinds;
  expect(kinds.find((k) => k.kind === "qualification_expiry")?.email).toBe(false);
  expect(kinds.find((k) => k.kind === "task_assigned")?.email).toBeNull();

  await owner.locator("#notices").getByRole("checkbox", { name: "A licence or skill running out: by email" }).check();
  await owner.locator("#notices").getByRole("button", { name: "Save what I am told" }).click();
  await expect(owner.locator("#notices").getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.reload();
  await expect(owner.locator("#notices").getByRole("checkbox", { name: "A licence or skill running out: by email" })).toBeChecked();
});
