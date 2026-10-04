import type { Locator, Page } from "@playwright/test";
import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * SELLING AND CLOSING AT THE KITCHEN TABLE, ON /my-day
 *
 * The office books the job. Ray, on a phone sized screen, builds a repair
 * and a replacement from the price book, turns the phone round, and the
 * customer chooses the replacement with an optional extra and signs on the
 * glass. Ray raises the invoice for what they signed for, they sign for it,
 * and pay cash with a tip for the crew. Every step goes through the same
 * offline queue the phone app uses. The office then sees the invoice paid at
 * the figure the customer signed for and the tip held for Ray.
 */

/** Today and the current minute on the company's wall clock, as the booking form takes them. */
function companyNow(timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` };
}

/** A signature, drawn with a finger's worth of strokes on the pad. */
async function sign(page: Page, pad: Locator) {
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 3, box.y + 20, { steps: 8 });
  await page.mouse.move(box.x + (2 * box.width) / 3, box.y + box.height - 20, { steps: 8 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function setTipping(owner: Page, on: boolean) {
  await owner.goto("/settings/portal");
  const box = owner.getByLabel("Offer customers a tip when they pay online");
  if (on) {
    await box.check();
    await owner.getByLabel("Suggested tips, in percent").fill("15, 20, 25");
  } else {
    await box.uncheck();
  }
  await owner.getByRole("button", { name: "Save tips" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
}

test("a technician builds options on /my-day, the customer chooses and signs, and pays cash with a tip for the crew", async ({ owner, tech }) => {
  const customer = `Odile Fairbanks ${run}`;
  const summary = `No heat, igniter glowing ${run}`;
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0177",
    address: { street: "41 Bluebonnet Ln", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: "41 Bluebonnet Ln, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(summary);
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

  await setTipping(owner, true);
  try {
    await tech.goto("/my-day");
    const visit = tech.getByRole("article").filter({ hasText: customer });
    await visit.getByRole("button").first().click();

    // Good and better, from the price book, with the thermostat as an extra on better.
    await visit.getByRole("button", { name: "Build good, better, best" }).click();
    const builder = visit.getByRole("region", { name: "New estimate" });
    await builder.getByLabel("Find in the price book").fill("flame");
    await builder.getByRole("button", { name: "Add Flame sensor clean or replace" }).click();
    await builder.getByRole("button", { name: "Add an option" }).click();
    await builder.getByLabel("Find in the price book").fill("igniter");
    await builder.getByRole("button", { name: "Add Hot surface igniter" }).click();
    await builder.getByLabel("Find in the price book").fill("smart thermostat");
    await builder.getByRole("button", { name: "Add Smart thermostat, installed" }).click();
    await builder.getByRole("button", { name: "Make it optional" }).last().click();
    await builder.getByRole("button", { name: "Recommend this one" }).click();
    await expect(builder.getByRole("tab", { name: /Better/ })).toContainText("$319.00");
    await builder.getByRole("button", { name: "Save and show the customer" }).click();

    // Turned round: the customer's screen, recommended first, prices and nothing about cost.
    const present = visit.getByRole("region", { name: "Your options" });
    await expect(present.getByRole("radio").first()).toHaveAccessibleName("Better, $319.00");
    await expect(present).not.toContainText(/cost|margin/i);
    await present.getByRole("radio", { name: "Better, $319.00" }).click();
    await present.getByRole("button", { name: "Add Smart thermostat, installed" }).click();
    await present.getByRole("button", { name: "Choose Better: $908.00" }).click();
    await expect(present.getByLabel("Name of the person signing")).toHaveValue(customer);
    await sign(tech, present.getByRole("img", { name: "Customer's signature" }));
    await present.getByRole("button", { name: "Sign", exact: true }).click();

    const estimates = visit.getByRole("region", { name: "Estimates" });
    await expect(estimates).toContainText(`Approved, signed by ${customer}`);

    // The invoice for what they signed for, shown to them and signed for.
    const invoice = visit.getByRole("region", { name: "Invoice" });
    await invoice.getByRole("button", { name: "Raise the invoice" }).click();
    await invoice.getByRole("radio", { name: /The option they signed for: Better/ }).check();
    await invoice.getByRole("button", { name: "Show the customer" }).click();
    await expect(invoice).toContainText("Smart thermostat, installed");
    await expect(invoice).toContainText("$908.00");
    await sign(tech, invoice.getByRole("img", { name: "Customer's signature on the invoice" }));
    await invoice.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(invoice).toContainText("Invoice raised here: $908.00");

    // Cash for the invoice, and twenty per cent on top for the crew.
    await expect(visit.getByText("Owed on this job: $908.00")).toBeVisible();
    await expect(visit.getByLabel("Amount", { exact: true })).toHaveValue("908.00");
    await visit.getByRole("button", { name: "Tip 20 per cent" }).click();
    await expect(visit.getByLabel("Tip", { exact: true })).toHaveValue("181.60");
    await visit.getByRole("button", { name: "Record cash payment" }).click();
    await expect(visit.getByText("Cash $908.00, tip $181.60,")).toBeVisible();

    // Not just on the page: in the system, once the queue has sent it.
    await expect(tech.getByText(/All sent/)).toBeVisible();
    await tech.reload();
    const after = tech.getByRole("article").filter({ hasText: customer });
    await after.getByRole("button").first().click();
    await expect(after.getByRole("region", { name: "Invoice" })).toContainText(/Invoice \d+: \$908\.00, paid/);
    await expect(after.getByRole("region", { name: "Estimates" })).toContainText("Invoiced");

    // The office: paid at the figure the customer signed for, signed for on site, and the tip held for Ray.
    const db = createClient();
    let invoiceId = "";
    try {
      const rows = await db.execute<{ id: string; status: string; total: string; signer: string | null }>(sql`
        select i.id, i.status, i.total::text as total,
               (select s.signer_name from public.document_signature s where s.subject = 'invoice' and s.subject_id = i.id limit 1) as signer
          from public.invoice i join public.job j on j.id = i.job_id
         where j.summary = ${summary}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "paid", total: "908.0000", signer: customer });
      invoiceId = rows[0]!.id;
    } finally {
      await db.$close();
    }
    await owner.goto(`/invoices/${invoiceId}`);
    await expect(owner.getByText(new RegExp(`^${customer}, .*, on the technician's phone`))).toBeVisible();
    const tips = owner.getByRole("region", { name: "Tips" });
    await expect(tips).toContainText("Ray Ortiz");
    await expect(tips).toContainText("$181.60");
  } finally {
    await setTipping(owner, false);
  }
});
