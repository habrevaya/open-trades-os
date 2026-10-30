import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * TELLING THE CUSTOMER THEY WERE GIVEN LONGER (M07)
 *
 * The office gives a customer longer on the estimate's page and ticks "Tell the
 * customer". The customer is emailed the new date with a link; a customer with
 * no mobile number, asked to be texted, is not told and the page says why while
 * the date has still moved.
 *
 * An email connection is written for the length of the spec and taken away
 * after, because the seeded company has none. Nothing leaves the machine:
 * queueing writes the outbox and nothing in the suite sends it.
 */
async function connectEmail(): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.insert(schema.integrationConnection).values({
      organizationId: E2E_ORGANIZATION_ID, capability: "email", provider: "smtp", status: "connected",
      accountLabel: "Tell spec", settings: { fromAddress: "office@e2e.test" },
    }).onConflictDoNothing().returning({ id: schema.integrationConnection.id });
    if (!row) throw new Error("The seeded company already has an email connection; this spec would take it away after.");
    return row.id;
  } finally {
    await db.$close();
  }
}

async function disconnectEmail(id: string): Promise<void> {
  const db = createClient();
  try {
    await db.delete(schema.integrationConnection).where(and(
      eq(schema.integrationConnection.id, id), eq(schema.integrationConnection.organizationId, E2E_ORGANIZATION_ID),
    ));
  } finally {
    await db.$close();
  }
}

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("the office gives a customer longer and tells them, and is told when they cannot be", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Wren Told ${run}`, email: `wren+${run}@example.test`,
    address: { street: "5 Told Terrace", city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;

  const sentEstimate = async (title: string) => {
    const made = await owner.request.post("/api/v1/estimates", {
      data: {
        customerId, propertyId, title, expiresOn: plus(companyToday(), 3),
        options: [{ name: "Replace", isRecommended: true, lines: [{ name: "Heater", quantity: "1", unitPrice: "900.00", discountAmount: "0", taxable: false }] }],
      },
    });
    expect(made.ok()).toBe(true);
    const id = ((await made.json()) as { id: string }).id;
    expect((await owner.request.post(`/api/v1/estimates/${id}/send`, { data: { channel: "link" } })).ok()).toBe(true);
    return id;
  };
  const giveLonger = async (id: string) => {
    await owner.goto(`/estimates/${id}`);
    await owner.getByText("Give them longer to answer").click();
    await owner.getByLabel("New good until date").fill(plus(companyToday(), 14));
    await owner.getByLabel("Why").fill("Waiting on their insurer.");
  };

  const connection = await connectEmail();
  try {
    // Off unless ticked: the customer hears nothing.
    const quiet = await sentEstimate(`Quiet longer ${run}`);
    await giveLonger(quiet);
    await owner.getByRole("button", { name: "Move the date" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "The link they were sent works until then." })).toBeVisible();
    await expect(owner.getByRole("status")).not.toContainText("The customer was told");

    // Ticked: emailed, and the email is one of the estimate's sends.
    const told = await sentEstimate(`Told longer ${run}`);
    await giveLonger(told);
    await expect(owner.getByLabel("Tell them by")).toHaveValue("email");
    await owner.getByLabel("Tell the customer.").check();
    await owner.getByRole("button", { name: "Move the date" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "The customer was told by email." })).toBeVisible();
    await owner.reload();
    const { deliveries: rows } = await (await owner.request.get(`/api/v1/estimates/${told}/deliveries`)).json() as
      { deliveries: { channel: string; destination: string | null }[] };
    expect(rows.some((d) => d.channel === "email" && d.destination === `wren+${run}@example.test`)).toBe(true);

    // Asked to text a customer with no number: the date moves and the page says they were not told.
    const nobody = await sentEstimate(`Not told ${run}`);
    await giveLonger(nobody);
    await owner.getByLabel("Tell the customer.").check();
    await owner.getByLabel("Tell them by").selectOption("sms");
    await owner.getByRole("button", { name: "Move the date" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "The customer was not told." })).toContainText("mobile number");
  } finally {
    await disconnectEmail(connection);
  }
});
