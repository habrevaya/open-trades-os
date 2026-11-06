import type { Page } from "@playwright/test";
import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE FIELD CONFLICTS LIST
 *
 * Two things a phone recorded that the office has to look at, written into
 * the operation log as the sync leaves them (the sync's own rules are tested
 * in the API suite): a furnace whose serial is on file at another customer's
 * address, and an arrival at a visit the office had cancelled. The office
 * moves the furnace on file to where the technician found it, which marks
 * that one dealt with, and marks the other dealt with with a note.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function address(owner: Page, name: string, street: string) {
  const customerId = await newCustomer(owner, { name, address: { street, city: "Austin", state: "TX", zip: "78704" } });
  const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
  return { customerId, propertyId };
}

/** An operation the phone sent that the sync held for the office. */
async function held(propertyId: string, kind: string, conflict: string, payload: Record<string, unknown>, subjectId: string | null = null) {
  const db = createClient();
  try {
    const [tech] = await db.execute<{ id: string; organization_id: string }>(sql`
      select t.id, t.organization_id from public.technician t
      join public.property p on p.organization_id = t.organization_id
      where p.id = ${propertyId}::uuid order by t.created_at limit 1`);
    if (!tech) throw new Error("No technician in the seeded company");
    const [device] = await db.execute<{ id: string }>(sql`
      insert into public.device (organization_id, technician_id, installation_id, label)
      values (${tech.organization_id}::uuid, ${tech.id}::uuid, ${`conflicts-${run}-${crypto.randomUUID()}`}, 'Test phone')
      returning id`);
    const [op] = await db.execute<{ id: string }>(sql`
      insert into public.field_operation
        (organization_id, device_id, technician_id, client_id, sequence, kind, subject_id, payload,
         occurred_at, claimed_at, status, conflict)
      values (${tech.organization_id}::uuid, ${device!.id}::uuid, ${tech.id}::uuid, ${crypto.randomUUID()}, 1, ${kind},
              ${subjectId}::uuid, ${JSON.stringify(payload)}::jsonb, now(), now(), 'conflicted', ${conflict})
      returning id`);
    return op!.id;
  } finally {
    await db.$close();
  }
}

test("the office moves a unit the phone found to where it was found, and marks another conflict dealt with", async ({ owner }) => {
  const serial = `FC${run.toUpperCase()}`;
  const before = await address(owner, `Old Owner ${run}`, `${run.slice(-4)} Former Ct`);
  const now = await address(owner, `New Owner ${run}`, `${run.slice(-4)} Current Ct`);
  const unit = await api<{ id: string }>(owner, "post", "/v1/equipment", {
    propertyId: before.propertyId, category: "furnace", manufacturer: "Carrier", model: `59SC ${run}`, serialNumber: serial,
  });

  await held(now.propertyId, "equipment.record",
    `Not added from the phone. Serial ${serial} is already on file at ${run.slice(-4)} Former Ct, Austin.`,
    { propertyId: now.propertyId, category: "furnace", manufacturer: "Carrier", model: `59SC ${run}`, serialNumber: serial, location: "Attic" });
  await held(now.propertyId, "visit.note", `A note sent ${run} after the office closed the visit.`, { text: "Left the gate open" });

  await owner.goto("/schedule/conflicts");
  await expect(owner.getByRole("heading", { level: 1, name: "Field conflicts" })).toBeVisible();

  const furnace = owner.getByTestId("conflict").filter({ hasText: `Serial ${serial} is already on file` });
  await expect(furnace).toContainText("A unit found on site");
  await expect(furnace).toContainText(`The phone sent: Carrier 59SC ${run}, serial ${serial}, Attic.`);
  await expect(furnace).toContainText("If it is the same unit, move the one on file here");
  await furnace.getByRole("button", { name: "Move it here" }).click();
  await expect(owner.getByTestId("conflict").filter({ hasText: `Serial ${serial} is already on file` })).toHaveCount(0);

  const moved = await api<{ propertyId: string }>(owner, "get", `/v1/equipment/${unit.id}`);
  expect(moved.propertyId).toBe(now.propertyId);

  const note = owner.getByTestId("conflict").filter({ hasText: `A note sent ${run}` });
  await note.getByLabel("What you did").fill("Rang them, the gate is shut.");
  await note.getByRole("button", { name: "Mark it dealt with" }).click();
  await expect(owner.getByTestId("conflict").filter({ hasText: `A note sent ${run}` })).toHaveCount(0);

  await owner.getByRole("link", { name: "Include the ones dealt with" }).click();
  await expect(owner.getByTestId("conflict").filter({ hasText: `A note sent ${run}` })).toContainText("Dealt with");
  await expect(owner.getByTestId("conflict").filter({ hasText: `A note sent ${run}` }).getByRole("button")).toHaveCount(0);
});
