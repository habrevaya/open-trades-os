import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A CUSTOMER'S UPLOAD IS NOTICED
 *
 * The office books a job for today with Ray on it. The customer signs in and
 * sends a photo to the job. The office's queue has one task for it, the job's
 * page says at the top that the customer sent a new file and marks it new, and
 * Ray's bell tells him. Opening the file from the job's page takes the mark
 * away and finishes the task.
 */

async function textTo(e164: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.select({ body: schema.message.body }).from(schema.message)
      .where(and(eq(schema.message.toAddress, e164), eq(schema.message.direction, "outbound")))
      .orderBy(desc(schema.message.createdAt)).limit(1);
    return row?.body ?? "";
  } finally {
    await db.$close();
  }
}

function companyNow(timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${parts["hour"]}:${parts["minute"]}` };
}

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("a customer's photo from their account raises a task, tells the technician and is new on the job until opened", async ({ owner, tech, stranger, baseURL }) => {
  test.setTimeout(240_000);
  const digits = String(Date.now() + 7).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Ivy Uploader ${run}`;
  const photo = `heater-${run}.png`;

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();

  await newCustomer(owner, { name, phone, address: { street: "52 Upload Ave", city: "Austin", state: "TX", zip: "78745" } });
  await owner.getByRole("link", { name: "52 Upload Ave, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Water heater leaking ${run}`);
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();

  await stranger.goto(signInUrl);
  await stranger.getByLabel("Email or mobile number").fill(phone);
  await stranger.getByRole("button", { name: "Send me a code" }).click();
  await expect(stranger.getByLabel("Code")).toBeVisible();
  let code: string | undefined;
  await expect.poll(async () => {
    code = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
    return code;
  }).toMatch(/^\d{6}$/);
  await stranger.getByLabel("Code").fill(code!);
  await stranger.getByRole("button", { name: "Sign in" }).click();
  await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);
  await stranger.getByRole("link", { name: "Send us a photo or a PDF about a job" }).click();
  const send = stranger.getByRole("region", { name: "Send a file" });
  const jobOption = send.getByRole("option", { name: new RegExp(`Water heater leaking ${run}$`) });
  await send.getByLabel("What is it about?").selectOption({ label: (await jobOption.textContent())! });
  await send.getByLabel("A photo or a PDF").setInputFiles({ name: photo, mimeType: "image/png", buffer: PIXEL });
  await send.getByRole("button", { name: "Send the file" }).click();
  await expect(send.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();

  /** The office: one task in the queue, and the job says so at the top and marks the file new. */
  await owner.goto(jobUrl);
  await expect(owner.getByRole("status").filter({ hasText: "The customer sent a new file from their account." })).toBeVisible();
  const files = owner.getByRole("region", { name: "Files" });
  const row = files.getByRole("listitem").filter({ hasText: photo });
  await expect(row).toContainText("New");
  await expect(files).toContainText("From the customer, 1 new");

  await owner.goto("/tasks");
  const task = owner.getByRole("link", { name: `${name} sent a file to job`, exact: false });
  await expect(task.first()).toBeVisible();
  const taskHref = (await task.first().getAttribute("href"))!;

  /** Ray's bell tells him, opening his day. */
  await tech.goto("/notices");
  await expect(tech.getByRole("list", { name: "Your notices" }).getByRole("link", { name: `${name} sent a photo for job` })).toBeVisible();

  /** Opening it from the job's page takes the mark away and finishes the task. */
  await owner.goto(jobUrl);
  const href = (await owner.getByRole("region", { name: "Files" }).getByRole("listitem").filter({ hasText: photo })
    .getByRole("link", { name: photo }).getAttribute("href"))!;
  const opened = await owner.request.get(new URL(href, baseURL!).toString());
  expect(opened.status()).toBe(200);
  await owner.reload();
  await expect(owner.getByRole("status").filter({ hasText: "The customer sent" })).toHaveCount(0);
  await expect(owner.getByRole("region", { name: "Files" }).getByRole("listitem").filter({ hasText: photo })).not.toContainText("New");
  await owner.goto(taskHref);
  await expect(owner.getByText("Everything the customer sent has been opened.")).toBeVisible();
});
