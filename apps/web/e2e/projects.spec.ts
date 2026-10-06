import type { Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * M12 IN A BROWSER: A CHANGE ORDER THE CUSTOMER SIGNS, AND AN APPLICATION FOR
 * PAYMENT THAT BECOMES AN INVOICE.
 *
 * The two flows on a project where money changes hands. A change order is
 * logged and priced in the office, the link goes to the customer, who signs
 * it on their own device with nobody signed in, and only then does the
 * contract on the office's screen move. An application is filled in line by
 * line, worked through to a payment due with retainage held, and raised as
 * an invoice for exactly that.
 */

/** A project for a fresh customer, through the office's own form, and its phases. */
async function startProject(owner: Page, input: {
  name: string; customer: string; contract: string; phases: { name: string; value: string }[];
}): Promise<string> {
  const customerId = await newCustomer(owner, {
    name: input.customer, address: { street: "14 Hillcrest Dr", city: "Austin", state: "TX", zip: "78701" },
  });
  await owner.goto("/projects");
  await owner.getByRole("link", { name: "Start a project" }).click();
  await owner.getByLabel("Customer").selectOption(customerId);
  await owner.getByRole("button", { name: "Next" }).click();
  await owner.getByLabel("Name").fill(input.name);
  await owner.getByLabel("Contract value").fill(input.contract);
  await owner.getByRole("button", { name: "Start project" }).click();
  await expect(owner).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectId = owner.url().split("/").pop()!;

  for (const phase of input.phases) {
    await owner.getByPlaceholder("Rough-in", { exact: true }).fill(phase.name);
    await owner.getByPlaceholder("Billing value").fill(phase.value);
    await owner.getByRole("button", { name: "Add phase" }).click();
    await expect(owner.getByText(phase.name).first()).toBeVisible();
  }
  return projectId;
}

test("Change order: priced in the office, signed by the customer on their link, and only then on the contract", async ({ owner, stranger }) => {
  const projectId = await startProject(owner, {
    name: `Hillcrest fit out ${run}`, customer: `Pat Owner ${run}`, contract: "40000.00",
    phases: [{ name: "Rough in", value: "25000.00" }, { name: "Finishes", value: "15000.00" }],
  });

  await owner.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Change orders" }).click();
  await owner.getByLabel("What is the change").fill("Two more circuits in the kitchen");
  await owner.getByLabel("Asked for by").fill("Pat");
  await owner.getByLabel("Phase it lands on").selectOption({ label: "Rough in" });
  await owner.getByRole("button", { name: "Log change" }).click();
  await expect(owner).toHaveURL(/\/change-orders\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1 })).toContainText("Change order 1: Two more circuits in the kitchen");

  const typed = owner.getByRole("group", { name: "Typed by hand" });
  await typed.getByLabel("What it is").fill("Dedicated 20A circuit");
  await typed.getByLabel("Quantity").fill("2");
  await typed.getByLabel("Price", { exact: true }).fill("450.00");
  await typed.getByRole("button", { name: "Add line" }).click();
  await expect(owner.getByRole("cell", { name: "Dedicated 20A circuit" })).toBeVisible();
  await expect(owner.getByText("Priced, not sent")).toBeVisible();

  await owner.getByLabel("Just give me the link").check();
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  const link = owner.getByRole("link", { name: /\/co\// });
  await expect(link).toBeVisible();
  const path = new URL((await link.getAttribute("href"))!).pathname;

  /** The contract has not moved: a change order with the customer is a question, not an answer. */
  await owner.goto(`/projects/${projectId}`);
  await expect(owner.getByText("$40,000.00").first()).toBeVisible();

  await stranger.goto(path);
  await expect(stranger.getByRole("heading", { level: 1 })).toContainText("Change order 1: Two more circuits in the kitchen");
  await expect(stranger.getByText("This adds $900.00 to your contract of $40,000.00, making it $40,900.00.")).toBeVisible();
  await stranger.getByLabel("Your name").fill(`Pat Owner ${run}`);
  await stranger.getByRole("button", { name: "Approve and sign" }).click();
  await expect(stranger.getByText("Approved", { exact: true })).toBeVisible();
  await expect(stranger.getByText(`Signed by Pat Owner ${run}. Your contract is now $40,900.00.`)).toBeVisible();

  await owner.goto(`/projects/${projectId}/change-orders`);
  const row = owner.getByRole("row").filter({ hasText: "Two more circuits in the kitchen" });
  await expect(row).toContainText("Agreed");
  await expect(row).toContainText("$40,900.00");
  await owner.goto(`/projects/${projectId}`);
  await expect(owner.getByText("$40,900.00").first()).toBeVisible();
});

test("Application for payment: filled in line by line, retainage held, and raised as an invoice for what is due", async ({ owner }) => {
  const projectId = await startProject(owner, {
    name: `Riverside build ${run}`, customer: `Riverside Plaza ${run}`, contract: "20000.00",
    phases: [{ name: "Framing", value: "12000.00" }, { name: "Finishes", value: "8000.00" }],
  });

  await owner.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Applications for payment" }).click();
  await owner.getByLabel("Retainage on work, %").fill("10");
  await owner.getByLabel("Retainage on stored materials, %").fill("10");
  await owner.getByRole("button", { name: "Start application" }).click();
  await expect(owner).toHaveURL(new RegExp(`/projects/${projectId}/applications/[0-9a-f-]{36}$`));
  await expect(owner.getByRole("heading", { level: 1 })).toContainText("application 1");

  await owner.getByLabel("Framing, work this period").fill("6000");
  await owner.getByLabel("Finishes, stored now").fill("1000");
  await owner.getByRole("button", { name: "Save" }).click();

  /** 6,000 of work and 1,000 stored, 10% held on each: 7,000 less 700 is 6,300 due. */
  const summary = owner.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("$7,000.00");
  await expect(summary).toContainText("$700.00");
  await expect(summary).toContainText(/Payment due now\s*\$6,300\.00/);

  await owner.getByRole("button", { name: "Raise the invoice" }).click();
  await expect(owner.getByText("Invoiced", { exact: true })).toBeVisible();
  await owner.getByRole("link", { name: "Its invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("$6,300.00").first()).toBeVisible();
  await expect(owner.getByText("Framing").first()).toBeVisible();

  await owner.goto(`/projects/${projectId}/applications`);
  await expect(owner.getByRole("link", { name: /Application 1/ })).toContainText("$6,300.00");
});

/** A phase through the project's own form, with the days it runs and, optionally, the one it waits for. */
async function addPhase(owner: Page, phase: {
  name: string; value: string; startsOn: string; endsOn: string; waitsFor?: string;
}) {
  await owner.getByPlaceholder("Rough-in", { exact: true }).fill(phase.name);
  await owner.getByPlaceholder("Billing value").fill(phase.value);
  await owner.getByLabel("Starts").fill(phase.startsOn);
  await owner.getByLabel("Ends").fill(phase.endsOn);
  if (phase.waitsFor) await owner.getByRole("combobox").filter({ hasText: "Waits for nothing" }).selectOption({ label: `Waits for ${phase.waitsFor}` });
  await owner.getByRole("button", { name: "Add phase" }).click();
  await expect(owner.getByRole("listitem").filter({ hasText: phase.name }).first()).toBeVisible();
}

test("Change order days: proposed first, nothing moves until the office applies them, and then the later phases move", async ({ owner }) => {
  const projectId = await startProject(owner, {
    name: `Lakeline remodel ${run}`, customer: `Lakeline Homes ${run}`, contract: "40000.00", phases: [],
  });
  await addPhase(owner, { name: "Rough in", value: "25000.00", startsOn: "2026-11-02", endsOn: "2026-11-06" });
  await addPhase(owner, { name: "Finishes", value: "15000.00", startsOn: "2026-11-09", endsOn: "2026-11-13", waitsFor: "Rough in" });

  await owner.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Change orders" }).click();
  await owner.getByLabel("What is the change").fill("Hidden pipe behind the wall");
  await owner.getByLabel("Phase it lands on").selectOption({ label: "Rough in" });
  await owner.getByLabel("Days it adds to the job").fill("3");
  await owner.getByRole("button", { name: "Log change" }).click();
  await expect(owner).toHaveURL(/\/change-orders\/[0-9a-f-]{36}$/);

  const typed = owner.getByRole("group", { name: "Typed by hand" });
  await typed.getByLabel("What it is").fill("Reroute the supply line");
  await typed.getByLabel("Price", { exact: true }).fill("600.00");
  await typed.getByRole("button", { name: "Add line" }).click();
  await expect(owner.getByRole("cell", { name: "Reroute the supply line" })).toBeVisible();

  /** Not agreed yet, so there is no schedule section at all. */
  await expect(owner.getByRole("region", { name: "The schedule" })).toHaveCount(0);
  const answer = owner.getByRole("region", { name: "Record their answer" });
  await answer.getByLabel("Who signed or answered").fill(`Pat Owner ${run}`);
  await answer.getByRole("button", { name: "Record" }).click();
  await expect(owner.getByText(/Agreed by Pat Owner/)).toBeVisible();

  const section = owner.getByRole("region", { name: "The schedule" });
  await expect(section).toContainText("Nothing moves until you apply them.");
  await expect(section).toContainText(
    "Adds 3 days to Rough in and moves 1 later phase out by the same. The finish moves from 2026-11-13 to 2026-11-16.",
  );
  const finishes = section.getByRole("row").filter({ hasText: "Finishes" });
  await expect(finishes).toContainText("2026-11-09 to 2026-11-13");
  await expect(finishes).toContainText("2026-11-12 to 2026-11-16");

  /** Looking at it moved nothing. */
  await owner.goto(`/projects/${projectId}/schedule`);
  await expect(owner.getByText("Planned to finish on 2026-11-13.")).toBeVisible();

  await owner.goBack();
  await owner.getByRole("region", { name: "The schedule" }).getByRole("button", { name: "Apply to the schedule" }).click();
  await expect(owner.getByRole("region", { name: "The schedule" })).toContainText("were put on the schedule");
  await owner.reload();
  await expect(owner.getByRole("region", { name: "The schedule" })).toContainText("They are not applied twice.");
  await expect(owner.getByRole("button", { name: "Apply to the schedule" })).toHaveCount(0);

  await owner.goto(`/projects/${projectId}/schedule`);
  await expect(owner.getByText(/Planned to finish on 2026-11-16\./)).toBeVisible();
});

test("The schedule marks somebody booked on two phases at once, names them and the days, and moves nobody", async ({ owner }) => {
  const projectId = await startProject(owner, {
    name: `Eastside refit ${run}`, customer: `Eastside Dental ${run}`, contract: "30000.00", phases: [],
  });
  await addPhase(owner, { name: "Plumbing", value: "15000.00", startsOn: "2026-11-02", endsOn: "2026-11-13" });
  await addPhase(owner, { name: "Electrical", value: "15000.00", startsOn: "2026-11-10", endsOn: "2026-11-18" });
  await owner.getByRole("button", { name: "Create a job for each phase without one" }).click();
  await expect(owner.getByRole("link", { name: "Job 1" })).toHaveCount(2);

  const person = `Ray Nunez ${run}`;
  const db = createClient();
  try {
    await db.execute(sql`
      with tech as (
        insert into public.technician (organization_id, membership_id, display_name)
        select organization_id, id, ${person} from public.membership
         where organization_id = (select organization_id from public.project where id = ${projectId}) limit 1
        returning id, organization_id),
      visits as (
        insert into public.visit (organization_id, job_id, status, window_start, window_end)
        select (select organization_id from tech), pj.job_id, 'scheduled',
               case when ph.name = 'Plumbing' then timestamptz '2026-11-11 15:00:00+00' else timestamptz '2026-11-12 15:00:00+00' end,
               case when ph.name = 'Plumbing' then timestamptz '2026-11-11 18:00:00+00' else timestamptz '2026-11-12 18:00:00+00' end
          from public.project_job pj join public.project_phase ph on ph.id = pj.project_phase_id
         where pj.project_id = ${projectId}
        returning id)
      insert into public.visit_assignment (organization_id, visit_id, technician_id)
      select (select organization_id from tech), visits.id, (select id from tech) from visits`);

    await owner.goto(`/projects/${projectId}/schedule`);
    const warning = owner.getByLabel("Booked twice", { exact: true });
    await expect(warning).toContainText(`${person} is booked on Plumbing and Electrical, which both run from 2026-11-10 to 2026-11-13.`);
    await expect(warning).toContainText("Nobody has been moved.");
    await expect(owner.locator(`[data-clash="${person}"]`)).toHaveCount(2);
    await expect(owner.getByRole("slider", { name: new RegExp(`Plumbing.*${person} booked twice`) })).toBeVisible();
    await expect(owner.getByRole("listitem").filter({ hasText: "Plumbing" }).getByText("Booked twice")).toBeVisible();

    /** Still booked on both, on the same days: the page read the schedule and changed nothing. */
    const [kept] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from public.visit_assignment va join public.technician t on t.id = va.technician_id
       where t.display_name = ${person}`);
    expect(kept!.n).toBe(2);
  } finally {
    await db.execute(sql`delete from public.visit_assignment where technician_id in (select id from public.technician where display_name = ${person})`);
    await db.execute(sql`delete from public.technician where display_name = ${person}`);
    await db.$close();
  }
});
