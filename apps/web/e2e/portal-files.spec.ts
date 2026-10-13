import { eq, desc, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A CUSTOMER SENDS A PHOTOGRAPH BEFORE THE VISIT
 *
 * The office books a job for today with Ray on it. The customer signs in
 * with a code to their phone and sends a photograph of the broken unit to
 * the visit, and a PDF they then take back. A program renamed as a
 * photograph is refused in words. Ray sees the photograph on the visit on
 * his day; the office sees it on the job as from the customer, and opening
 * it there means the customer can no longer take it back.
 */

/** The newest text queued to a number: what the customer's phone shows. */
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

/** Today on the company's wall clock, as the booking form takes it. */
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

test("a customer sends a photo before the visit, the technician sees it and the office opens it", async ({ owner, tech, stranger, baseURL }) => {
  const digits = String(Date.now()).slice(-7);
  const phone = `(737) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  const e164 = `+1737${digits}`;
  const name = `Opal Fenwick ${run}`;
  const photo = `boiler-${run}.png`;

  await owner.goto("/settings/portal");
  const signInUrl = (await owner.getByLabel("The sign in address").textContent())!.trim();

  await newCustomer(owner, {
    name, phone, address: { street: "41 Kettle Run", city: "Austin", state: "TX", zip: "78745" },
  });
  await owner.getByRole("link", { name: "41 Kettle Run, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`No hot water ${run}`);
  const now = companyNow("America/Chicago");
  await owner.getByLabel("Day", { exact: true }).fill(now.date);
  await owner.getByLabel("Arrives from").fill(now.time);
  await owner.getByLabel("Ray Ortiz").check();
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();

  // The customer signs in with a code sent to their phone.
  await stranger.goto(signInUrl);
  await stranger.getByLabel("Email or mobile number").fill(phone);
  await stranger.getByRole("button", { name: "Send me a code" }).click();
  await expect(stranger.getByLabel("Code")).toBeVisible();
  let code: string | undefined;
  await expect.poll(async () => {
    code = /\b(\d{6})\b/.exec(await textTo(e164))?.[1];
    return code;
  }, { message: "a code was texted to the number on the customer's record" }).toMatch(/^\d{6}$/);
  await stranger.getByLabel("Code").fill(code!);
  await stranger.getByRole("button", { name: "Sign in" }).click();
  await expect(stranger).toHaveURL(/\/portal\/[^/]+\/account$/);

  await stranger.getByRole("link", { name: "Send us a photo or a PDF about a job" }).click();
  await expect(stranger.getByRole("heading", { level: 1, name: "Send us a photo or a PDF" })).toBeVisible();
  const send = stranger.getByRole("region", { name: "Send a file" });
  const visitOption = send.getByRole("option", { name: /^The visit on / });
  await send.getByLabel("What is it about?").selectOption({ label: (await visitOption.textContent())! });

  // A program renamed as a photograph is refused, in words.
  await send.getByLabel("A photo or a PDF").setInputFiles({
    name: "boiler.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
  });
  await send.getByRole("button", { name: "Send the file" }).click();
  await expect(send.getByRole("alert").filter({ hasText: "program" })).toBeVisible();

  // The photograph, then a PDF sent by mistake and taken back.
  await send.getByLabel("A photo or a PDF").setInputFiles({ name: photo, mimeType: "image/png", buffer: PIXEL });
  await send.getByRole("button", { name: "Send the file" }).click();
  await expect(send.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
  await send.getByLabel("A photo or a PDF").setInputFiles({
    name: "wrong.pdf", mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% wrong ${run}\n%%EOF\n`),
  });
  await send.getByRole("button", { name: "Send the file" }).click();
  const sent = stranger.getByRole("region", { name: "Files you sent" });
  const wrong = sent.getByRole("listitem").filter({ hasText: "wrong.pdf" });
  await expect(wrong).toContainText("Not opened yet.");
  await wrong.getByRole("button", { name: "Take it back" }).click();
  await expect(sent.getByRole("listitem").filter({ hasText: "wrong.pdf" })).toHaveCount(0);
  await expect(sent.getByRole("listitem").filter({ hasText: photo })).toContainText("Not opened yet.");

  // Ray sees it on the visit, on his phone.
  await tech.goto("/my-day");
  const visit = tech.getByRole("article").filter({ hasText: name });
  await visit.getByRole("button").first().click();
  await expect(visit.getByRole("region", { name: "From the customer" }).getByRole("link", { name: photo })).toBeVisible();

  // The office sees it on the job as the customer's; opening it means it stays.
  await owner.goto(jobUrl);
  const files = owner.getByRole("region", { name: "Files" });
  const fromThem = files.getByRole("listitem").filter({ hasText: photo });
  await expect(fromThem).toContainText("not opened yet");
  const href = (await fromThem.getByRole("link", { name: photo }).getAttribute("href"))!;
  const opened = await owner.request.get(new URL(href, baseURL!).toString());
  expect(opened.status()).toBe(200);
  expect(opened.headers()["content-type"]).toContain("image/png");
  await owner.reload();
  const openedRow = owner.getByRole("region", { name: "Files" }).getByRole("listitem").filter({ hasText: photo });
  await expect(openedRow).toContainText(", opened");
  await expect(openedRow).not.toContainText("not opened");
  await expect(owner.getByRole("region", { name: "Files" }).getByText("wrong.pdf")).toHaveCount(0);

  await stranger.reload();
  const kept = stranger.getByRole("region", { name: "Files you sent" }).getByRole("listitem").filter({ hasText: photo });
  await expect(kept).toContainText("has opened it, so it stays with the job.");
  await expect(kept.getByRole("button", { name: "Take it back" })).toHaveCount(0);
});
