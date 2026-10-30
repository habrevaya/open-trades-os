import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A TECHNICIAN ASKS FOR A PART FROM /my-day; THE OFFICE PLACES THE HOLD
 *
 * Ray, on site, asks the office for the part the unit needs, in his own words.
 * It raises a task in the office queue naming the job, the part and Ray; the
 * office orders the part and, from the task, puts the job on hold against the
 * order, which finishes the task. Ray's day then says the job is on hold for
 * the part. The phone never holds the job.
 */

/** Today and the current minute on the company's wall clock, as the booking form takes them. */
function companyNow(timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` };
}

/** A purchase order that went to a supplier, written as purchasing would have left it. */
async function sentOrder(vendorName: string): Promise<{ id: string; number: number }> {
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string; number: number }>(sql`
      with org as (select id from public.organization where slug = 'ridgeline'),
      v as (
        insert into public.vendor (organization_id, name) select id, ${vendorName} from org returning id, organization_id
      )
      insert into public.purchase_order (organization_id, number, vendor_id, default_location_id, status, submitted_at)
      select v.organization_id,
             (select coalesce(max(number), 0) + 1 from public.purchase_order where organization_id = v.organization_id),
             v.id,
             (select l.id from public.location l where l.organization_id = v.organization_id order by l.created_at limit 1),
             'submitted', now()
      from v returning id, number`);
    return { id: row!.id, number: Number(row!.number) };
  } finally {
    await db.$close();
  }
}

test("a technician asks for a part from /my-day, and the office holds the job for it from the task", async ({ owner, tech }) => {
  test.setTimeout(240_000);
  const customer = `Pat Partwait ${run}`;
  const part = `Condenser fan motor ${run}`;
  await newCustomer(owner, {
    name: customer, phone: "(512) 555-0172",
    address: { street: "48 Motor Way", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.getByRole("link", { name: "48 Motor Way, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`No cool ${run}`);
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();

  await tech.goto("/my-day");
  const visit = tech.getByRole("article").filter({ hasText: customer });
  await visit.getByRole("button").first().click();
  const parts = visit.getByRole("region", { name: "Parts for this job" });
  await parts.getByText("Ask the office for a part").click();
  await parts.getByRole("button", { name: "Send to the office" }).click();
  await expect(parts.getByRole("alert").filter({ hasText: "Say what part you need" })).toBeVisible();
  await parts.getByLabel("What part").fill(part);
  await parts.getByLabel("Anything else (optional)").fill("Model on the plate is 24ACC6");
  await parts.getByRole("button", { name: "Send to the office" }).click();
  await expect(parts).toContainText(part);
  await expect(tech.getByText(/All sent/)).toBeVisible();

  /** The office's task names the job, the part and who asked. */
  const order = await sentOrder(`Parts House ${run}`);
  await owner.goto(jobUrl);
  const asked = owner.getByRole("region", { name: "Parts asked for from the field" });
  await expect(asked).toContainText(part);
  await expect(asked).toContainText("Not ordered yet.");
  await asked.getByRole("link", { name: "Open the task" }).click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(`: ${part}`);
  const section = owner.getByRole("region", { name: "The part asked for" });
  await expect(section).toContainText("asked for by Ray Ortiz");
  await expect(section).toContainText("They said: Model on the plate is 24ACC6");

  await section.getByLabel("The purchase order the part is on").selectOption(order.id);
  await section.getByRole("button", { name: "Put the job on hold for this part" }).click();
  await expect(section).toContainText(`The job is on hold for it, on purchase order ${order.number}.`);
  await expect(owner.getByText("Done", { exact: true })).toBeVisible();

  await owner.goto(jobUrl);
  await expect(owner.getByRole("region", { name: "On hold" })).toContainText(`purchase order ${order.number}`);
  await expect(owner.getByRole("region", { name: "Parts asked for from the field" })).toContainText(`purchase order ${order.number}`);

  /** Ray's day says it. */
  await tech.reload();
  const again = tech.getByRole("article").filter({ hasText: customer });
  await again.getByRole("button").first().click();
  await expect(again.getByRole("region", { name: "Parts for this job" })).toContainText("ordered and the job is on hold for it");
});
