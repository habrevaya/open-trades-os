import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * FIND A VISIT BY ITS NOTES AND A MESSAGE BY WHAT IT SAYS
 *
 * The office remembers "the one where the gate code was in the note" and "the
 * text about the rhubarb order", not which visit or thread. The box finds the
 * visit by a word only in its notes and the message by a word only in its
 * body, each hit opens its own page, and the technician, never sent to that
 * job, finds neither.
 */
const visitWord = `quincefence${run}`;
const messageWord = `quincetext${run}`;

test("The search box finds a visit by its notes and a message by its words, and the technician finds neither", async ({ owner, tech, errors }) => {
  const customerId = await newCustomer(owner, {
    name: `Visit Search ${run}`,
    address: { street: `${run} Quince Ave`, city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
  const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const made = await owner.request.post("/api/v1/jobs", {
    headers: { "idempotency-key": `visit-search-job-${run}` },
    data: { customerId, propertyId, summary: "Service call" },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const jobId = (await made.json() as { id: string }).id;
  const start = new Date(Date.now() + 2 * 86_400_000);
  const visit = await owner.request.post(`/api/v1/jobs/${jobId}/visits`, {
    data: {
      windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3 * 3600_000).toISOString(),
      technicianIds: [],
    },
  });
  expect(visit.ok(), await visit.text()).toBe(true);
  const visitId = (await visit.json() as { id: string }).id;

  const db = createClient();
  let threadId = "";
  try {
    await db.execute(sql`update public.visit set technician_notes = ${`Gate code is in the ${visitWord} note`} where id = ${visitId}`);
    const [thread] = await db.execute<{ id: string }>(sql`
      insert into public.conversation (organization_id, channel, external_address, customer_id, job_id, status)
      select organization_id, 'sms', ${`quince-${run}`}, id, ${jobId}, 'open'
      from public.customer where id = ${customerId} returning id`);
    threadId = thread!.id;
    await db.execute(sql`
      insert into public.message (organization_id, conversation_id, direction, channel, from_address, to_address, body, status)
      select organization_id, id, 'inbound', 'sms', external_address, '+15125550000', ${`Please call about the ${messageWord} order`}, 'received'
      from public.conversation where id = ${threadId}`);
  } finally {
    await db.$close();
  }

  await owner.goto("/jobs");
  const box = owner.locator('input[aria-label="Find anything"]:visible');
  await box.fill(visitWord);
  await box.press("Enter");
  await expect(owner).toHaveURL(/\/search\?q=/);
  const visits = owner.getByRole("region", { name: "Visits" });
  await expect(visits.getByRole("listitem")).toHaveCount(1);
  await expect(visits).toContainText(`Visit Search ${run}`);
  await visits.getByRole("link").first().click();
  await expect(owner).toHaveURL(new RegExp(`/visits/${visitId}`));

  await owner.goto(`/search?q=${encodeURIComponent(messageWord)}`);
  const messages = owner.getByRole("region", { name: "Messages" });
  await expect(messages.getByRole("listitem")).toHaveCount(1);
  await expect(messages).toContainText(`Visit Search ${run}`);
  await messages.getByRole("link").first().click();
  await expect(owner).toHaveURL(new RegExp(`/inbox/${threadId}`));

  // One group alone, for the groups with no list of their own.
  await owner.goto(`/search?q=${encodeURIComponent(visitWord)}&in=visits`);
  await expect(owner.getByRole("heading", { level: 1, name: "Search: visits" })).toBeVisible();

  // The technician was never sent to this job, so neither word finds anything.
  for (const word of [visitWord, messageWord]) {
    await tech.goto(`/search?q=${encodeURIComponent(word)}`);
    await expect(tech.getByText("Nothing found")).toBeVisible();
    await expect(tech.getByText(`Visit Search ${run}`)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
