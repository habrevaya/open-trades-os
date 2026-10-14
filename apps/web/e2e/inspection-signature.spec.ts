import type { Locator, Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * AN INSPECTOR SIGNS WITH A FINGER ON /my-day
 *
 * The technician is let file inspections, runs a programme against today's
 * visit, answers it and draws their name. The drawing goes through the field
 * queue as the phone app's does and is stored the same way, so the printed
 * report shows the picture. Typing the name alone still files.
 */

const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/** A finger's worth of strokes in the box, tried again if the day redrew under the mouse. */
async function draw(page: Page, pad: Locator, button: Locator) {
  await expect(async () => {
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 3, box.y + 20, { steps: 8 });
    await page.mouse.move(box.x + (2 * box.width) / 3, box.y + box.height - 20, { steps: 8 });
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function bookToday(owner: Page, customer: string, street: string, summary: string) {
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0177",
    address: { street, city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: `${street}, Austin` }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(summary);
  await owner.getByLabel("Day", { exact: true }).fill(companyToday());
  await owner.getByLabel("Arrives from").fill("21:00");
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
}

/** A programme in the company's own list, and the technician let file and read inspections. */
async function letRayInspect(programName: string): Promise<void> {
  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.inspection_program (organization_id, name, standard, checkpoints)
      select id, ${programName}, 'Local plumbing code',
             ${JSON.stringify([
               { key: "shutoff", label: "Shutoff valve closes fully", severityOnFail: "major" },
               { key: "psi", label: "Pressure drop", requiresReading: true, unit: "psi", range: { min: 5, max: null }, severityOnFail: "major" },
             ])}::jsonb
        from public.organization where slug = 'ridgeline'`);
    // The technician preset holds neither permission; a company running inspections grants both to the people who do them.
    await db.execute(sql`
      update public.membership set grants = '["compliance:read", "compliance:write"]'::jsonb
       where id in (select t.membership_id from public.technician t
                      join public.organization o on o.id = t.organization_id
                     where o.slug = 'ridgeline' and t.display_name = 'Ray Ortiz')`);
  } finally {
    await db.$close();
  }
}

async function putRayBack(programName: string): Promise<void> {
  const db = createClient();
  try {
    await db.execute(sql`
      update public.membership set grants = '[]'::jsonb
       where id in (select t.membership_id from public.technician t
                      join public.organization o on o.id = t.organization_id
                     where o.slug = 'ridgeline' and t.display_name = 'Ray Ortiz')`);
    await db.execute(sql`update public.inspection_program set active = false where name = ${programName}`);
  } finally {
    await db.$close();
  }
}

/** Open the visit and answer both checkpoints, up to the point of signing. */
async function answer(tech: Page, customer: string, programName: string): Promise<Locator> {
  await tech.goto("/my-day");
  await ready(tech);
  const visit = tech.getByRole("article").filter({ hasText: customer });
  await visit.getByRole("button").first().click();
  await visit.getByLabel("Run an inspection").selectOption({ label: programName });
  await visit.getByRole("group", { name: "Shutoff valve closes fully" }).getByRole("button", { name: "Pass" }).click();
  await visit.getByLabel("Pressure drop reading").fill("8");
  await visit.getByLabel("Inspector", { exact: true }).fill("Ray Ortiz");
  await visit.getByLabel("Licence number").fill("BPAT-4471");
  return visit;
}

/** Sent, then the day reloaded so the server's own verdict is what it shows. */
async function expectVerdict(tech: Page, customer: string, programName: string, verdict: string) {
  const visit = tech.getByRole("article").filter({ hasText: customer });
  // Queued first, so it is on the list at once, and "Filed" once the queue has sent it.
  await expect(visit.getByRole("listitem").filter({ hasText: programName })).toBeVisible();
  await expect(visit.getByRole("listitem").filter({ hasText: programName })).toContainText("Filed", { timeout: 60_000 });
  // The server's own verdict comes back with the next load of the day.
  await expect(async () => {
    await tech.reload();
    await ready(tech);
    const again = tech.getByRole("article").filter({ hasText: customer });
    // The day remembers which cards were open, so it is opened only when it is not.
    if (!(await again.getByText("Inspections", { exact: true }).isVisible())) await again.getByRole("button").first().click();
    await expect(again.getByRole("listitem").filter({ hasText: programName })).toContainText(verdict, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

async function filedInspection(programName: string) {
  const db = createClient();
  try {
    const rows = await db.execute<{ id: string; signature_upload_id: string | null; signed_by_name: string | null }>(sql`
      select i.id, i.signature_upload_id, i.signed_by_name from public.inspection i
        join public.inspection_program p on p.id = i.program_id where p.name = ${programName}`);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  } finally {
    await db.$close();
  }
}

test("the inspector draws their signature on /my-day and the printed report shows it", async ({ tech, owner }) => {
  const customer = `Ines Inspect ${run}`;
  const programName = `Backflow test ${run}`;
  await bookToday(owner, customer, "14 Plantroom Way", `Yearly backflow test ${run}`);
  await letRayInspect(programName);

  try {
    const visit = await answer(tech, customer, programName);

    // Without a typed name it is refused in words, drawing or not.
    await visit.getByRole("button", { name: "File inspection" }).click();
    await expect(visit.getByRole("alert").filter({ hasText: "Type your name" })).toBeVisible();
    await visit.getByLabel("Type your name to sign it off").fill("Ray Ortiz");

    const clear = visit.getByRole("button", { name: "Clear signature" });
    await expect(clear).toBeDisabled();
    await draw(tech, visit.getByRole("img", { name: "Inspector's signature" }), clear);
    await expect(visit.getByText("Signed.", { exact: true })).toBeVisible();

    // Clearing takes the drawing off, and drawing again puts it back.
    await clear.click();
    await expect(clear).toBeDisabled();
    await draw(tech, visit.getByRole("img", { name: "Inspector's signature" }), clear);

    await visit.getByRole("button", { name: "File inspection" }).click();
    await expectVerdict(tech, customer, programName, "Passed");
  } finally {
    await putRayBack(programName);
  }

  // The report prints the picture the inspector drew, stored the way the phone app's is.
  const filed = await filedInspection(programName);
  expect(filed.signature_upload_id).not.toBeNull();
  expect(filed.signed_by_name).toBe("Ray Ortiz");
  // The picture goes up after the record lands, so the report shows it a moment later.
  await expect(async () => {
    await owner.goto(`/inspections/${filed.id}/report`);
    await expect(owner.getByRole("img", { name: "Signature of Ray Ortiz" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const image = await owner.request.get(await owner.getByRole("img", { name: "Signature of Ray Ortiz" }).getAttribute("src") as string);
  expect(image.ok()).toBe(true);
  expect(image.headers()["content-type"]).toContain("image/png");
});

test("typing the name alone still files the inspection, and the report prints the name with no picture", async ({ tech, owner }) => {
  const customer = `Tyne Typed ${run}`;
  const programName = `Backflow typed ${run}`;
  await bookToday(owner, customer, "15 Plantroom Way", `Typed backflow test ${run}`);
  await letRayInspect(programName);

  try {
    const visit = await answer(tech, customer, programName);
    await visit.getByLabel("Type your name to sign it off").fill("Ray Ortiz");
    await expect(visit.getByText("Draw it with your finger, or file it with your typed name only.")).toBeVisible();
    await visit.getByRole("button", { name: "File inspection" }).click();
    await expectVerdict(tech, customer, programName, "Passed");
  } finally {
    await putRayBack(programName);
  }

  const filed = await filedInspection(programName);
  expect(filed.signature_upload_id).toBeNull();
  expect(filed.signed_by_name).toBe("Ray Ortiz");
  await owner.goto(`/inspections/${filed.id}/report`);
  await expect(owner.getByText("Ray Ortiz").first()).toBeVisible();
  await expect(owner.getByRole("img", { name: "Signature of Ray Ortiz" })).toHaveCount(0);
});
