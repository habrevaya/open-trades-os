import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * FIND A VISIT BY THE CREW ON IT
 *
 * The office remembers "the one the shingle crew did", not the job number. The
 * box finds the visit by its crew's name, says the crew on the hit, and the hit
 * opens the visit.
 */
const crewName = `Ridgeline ${run}`;

test("The search box finds a visit by the crew it is booked to", async ({ owner, errors }) => {
  const customerId = await newCustomer(owner, {
    name: `Crew Search ${run}`,
    address: { street: `${run} Ridge Rd`, city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
  const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const made = await owner.request.post("/api/v1/jobs", {
    headers: { "idempotency-key": `crew-search-job-${run}` },
    data: { customerId, propertyId, summary: "Roof tear off" },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const jobId = (await made.json() as { id: string }).id;
  const start = new Date(Date.now() + 3 * 86_400_000);
  const visit = await owner.request.post(`/api/v1/jobs/${jobId}/visits`, {
    data: {
      windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3 * 3600_000).toISOString(),
      technicianIds: [],
    },
  });
  expect(visit.ok(), await visit.text()).toBe(true);
  const visitId = (await visit.json() as { id: string }).id;

  const db = createClient();
  try {
    await db.execute(sql`
      with made as (
        insert into public.crew (organization_id, name)
        select organization_id, ${crewName} from public.visit where id = ${visitId}
        returning id
      )
      update public.visit set crew_id = (select id from made) where id = ${visitId}`);
  } finally {
    await db.$close();
  }

  await owner.goto("/jobs");
  const box = owner.locator('input[aria-label="Find anything"]:visible');
  await box.fill(crewName);
  await box.press("Enter");
  await expect(owner).toHaveURL(/\/search\?q=/);
  const visits = owner.getByRole("region", { name: "Visits" });
  await expect(visits.getByRole("listitem")).toHaveCount(1);
  await expect(visits).toContainText(`Crew Search ${run}`);
  await expect(visits).toContainText(`crew ${crewName}`);
  await visits.getByRole("link").first().click();
  await expect(owner).toHaveURL(new RegExp(`/visits/${visitId}`));
  expect(errors).toEqual([]);
});
