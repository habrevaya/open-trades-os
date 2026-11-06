import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * MORE KINDS OF CHECKPOINT, SECTIONS, A CODE REFERENCE, AND A DRAFT
 *
 * The owner writes a programme with a count, a photo and a note under two
 * headings, with the code each checkpoint comes from, keeps it as a draft
 * that nobody can use, and publishes it. The technician runs one like it on
 * /my-day: the count says when it is short, the note is the answer, the
 * optional checkpoint is left blank, and the printed report shows the
 * headings and the codes.
 */

const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

test("an owner keeps a programme with a count, a photo and a note as a draft, then publishes it", async ({ owner }) => {
  const name = `Sprinkler annual ${run}`;
  await owner.goto("/inspections/programmes/new");
  await owner.getByLabel("Name", { exact: true }).fill(name);

  const checkpoint = (n: number) => owner.getByRole("group", { name: `Checkpoint ${n}`, exact: true });
  await checkpoint(1).getByLabel("Question").fill("Photo of the pump nameplate");
  await checkpoint(1).getByLabel("Answer").selectOption({ label: "A photo" });
  await checkpoint(1).getByLabel("Section").fill("Pump room");
  // A photo is what was seen, so it is not asked how serious a fail is.
  await expect(checkpoint(1).getByLabel("How serious a fail is")).toHaveCount(0);

  await owner.getByRole("button", { name: "Add a checkpoint" }).click();
  await checkpoint(2).getByLabel("Question").fill("Spare heads in the cabinet");
  await checkpoint(2).getByLabel("Answer").selectOption({ label: "A count" });
  await checkpoint(2).getByLabel("Section").fill("Riser");
  await checkpoint(2).getByLabel("Code reference").fill("NFPA 25 5.4.1.4");
  await checkpoint(2).getByLabel("How serious too few is").selectOption({ label: "Wearing out: fix within 180 days" });

  await owner.getByRole("button", { name: "Add a checkpoint" }).click();
  await checkpoint(3).getByLabel("Question").fill("Anything else at the riser");
  await checkpoint(3).getByLabel("Answer").selectOption({ label: "A note" });
  await checkpoint(3).getByLabel("Section").fill("Riser");
  await checkpoint(3).getByRole("checkbox", { name: /Optional/ }).check();

  // Kept as a draft without how many spare heads there should be: a draft is not checked.
  await owner.getByRole("button", { name: "Save as a draft" }).click();
  await expect(owner).toHaveURL(/\/inspections\/programmes\/[0-9a-f-]{36}\?draft=saved$/);
  await expect(owner.getByRole("status")).toContainText("Saved as a draft.");
  await expect(owner.getByText("Nobody can use it until it is published", { exact: true })).toBeVisible();
  await expect(owner.getByRole("note")).toContainText("without saying how many there should be");
  const id = /programmes\/([0-9a-f-]{36})/.exec(owner.url())![1]!;

  await owner.goto("/inspections/programmes");
  await expect(owner.getByRole("region", { name: "Drafts" }).getByRole("link", { name })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Offered to technicians" }).getByRole("link", { name })).toHaveCount(0);

  // Published as it is, it is refused in words and the draft keeps what was typed.
  await owner.goto(`/inspections/programmes/${id}`);
  await owner.getByRole("button", { name: "Publish it" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "It was not published" })).toContainText("how many there should be");
  await expect(checkpoint(2).getByLabel("Code reference")).toHaveValue("NFPA 25 5.4.1.4");

  await checkpoint(2).getByLabel("Fewest there should be").fill("6");
  await owner.getByRole("button", { name: "Publish it" }).click();
  await expect(owner).toHaveURL(new RegExp(`/inspections/programmes/${id}\\?published=1$`));
  await expect(owner.getByRole("status")).toContainText("Saved as version 1.");
  await expect(owner.getByText("Offered to technicians", { exact: true })).toBeVisible();

  const response = await owner.request.get(`/api/v1/inspection-programs/${id}`);
  const detail = await response.json() as { program: { draft: boolean; checkpoints: Record<string, unknown>[] } };
  expect(detail.program.draft).toBe(false);
  expect(detail.program.checkpoints.map((c) => [c["answerKind"], c["section"]])).toEqual([
    ["photo", "Pump room"], ["count", "Riser"], ["note", "Riser"],
  ]);
  expect(detail.program.checkpoints[1]).toMatchObject({ expectedAtLeast: 6, codeReference: "NFPA 25 5.4.1.4" });

  // Taken off the phone again so no other test is offered it.
  await owner.getByRole("button", { name: "Stop offering it to technicians" }).click();
  await expect(owner.getByText("Not offered", { exact: true })).toBeVisible();
});

test("a technician answers a count and a note on /my-day and the report prints the headings and codes", async ({ tech, owner }) => {
  const customer = `Rita Riser ${run}`;
  const programName = `Riser check ${run}`;
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0178",
    address: { street: "16 Riser Row", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: "16 Riser Row, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Riser check ${run}`);
  await owner.getByLabel("Day", { exact: true }).fill(companyToday());
  await owner.getByLabel("Arrives from").fill("21:00");
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

  const db = createClient();
  try {
    await db.execute(sql`
      insert into public.inspection_program (organization_id, name, standard, checkpoints)
      select id, ${programName}, 'NFPA 25',
             ${JSON.stringify([
               { key: "valve", label: "Control valve open", severityOnFail: "major", section: "Riser", codeReference: "NFPA 25 13.3.2" },
               { key: "heads", label: "Spare heads in the cabinet", answerKind: "count", expectedAtLeast: 6, severityOnFail: "minor", section: "Riser", codeReference: "NFPA 25 5.4.1.4" },
               { key: "room", label: "State of the room", answerKind: "note", section: "Room" },
               { key: "photo", label: "Photo of the gauges", answerKind: "photo", optional: true, section: "Room" },
             ])}::jsonb
        from public.organization where slug = 'ridgeline'`);
    await db.execute(sql`
      update public.membership set grants = '["compliance:read", "compliance:write"]'::jsonb
       where id in (select t.membership_id from public.technician t
                      join public.organization o on o.id = t.organization_id
                     where o.slug = 'ridgeline' and t.display_name = 'Ray Ortiz')`);
  } finally {
    await db.$close();
  }

  try {
    await tech.goto("/my-day");
    await ready(tech);
    const visit = tech.getByRole("article").filter({ hasText: customer });
    await visit.getByRole("button").first().click();
    await visit.getByLabel("Run an inspection").selectOption({ label: programName });

    await expect(visit.getByRole("heading", { name: "Riser" })).toBeVisible();
    await expect(visit.getByRole("heading", { name: "Room" })).toBeVisible();
    await expect(visit.getByText("Code: NFPA 25 5.4.1.4")).toBeVisible();
    await visit.getByRole("group", { name: "Control valve open" }).getByRole("button", { name: "Pass" }).click();
    await visit.getByLabel("Spare heads in the cabinet count").fill("4");
    await expect(visit.getByText("Fewer than the 6 there should be. This will be a finding.")).toBeVisible();
    await visit.getByLabel("State of the room: what you saw").fill("Riser room is used for storage");
    await expect(visit.getByText("Take a photo to answer this.")).toBeVisible();
    await visit.getByLabel("Inspector", { exact: true }).fill("Ray Ortiz");
    await visit.getByLabel("Type your name to sign it off").fill("Ray Ortiz");
    // The optional photo left blank does not hold it up, so it files without asking.
    await visit.getByRole("button", { name: "File inspection" }).click();
    await expect(visit.getByRole("listitem").filter({ hasText: programName })).toContainText("Filed", { timeout: 60_000 });
  } finally {
    const again = createClient();
    try {
      await again.execute(sql`
        update public.membership set grants = '[]'::jsonb
         where id in (select t.membership_id from public.technician t
                        join public.organization o on o.id = t.organization_id
                       where o.slug = 'ridgeline' and t.display_name = 'Ray Ortiz')`);
      await again.execute(sql`update public.inspection_program set active = false where name = ${programName}`);
    } finally {
      await again.$close();
    }
  }

  const check = createClient();
  let id = "";
  try {
    const rows = await check.execute<{ id: string; result: string }>(sql`
      select i.id, i.result from public.inspection i
        join public.inspection_program p on p.id = i.program_id where p.name = ${programName}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe("pass_with_deficiencies");
    id = rows[0]!.id;
  } finally {
    await check.$close();
  }

  await owner.goto(`/inspections/${id}/report`);
  await expect(owner.getByText("Riser", { exact: true })).toBeVisible();
  await expect(owner.getByText("Room", { exact: true })).toBeVisible();
  await expect(owner.getByText("Code: NFPA 25 13.3.2")).toBeVisible();
  await expect(owner.getByRole("row").filter({ hasText: "State of the room" })).toContainText("Recorded");
  await expect(owner.getByRole("row").filter({ hasText: "Photo of the gauges" })).toContainText("Optional, not checked");
  await expect(owner.getByRole("row").filter({ hasText: "Spare heads in the cabinet" }).first()).toContainText("at least 6");
});
