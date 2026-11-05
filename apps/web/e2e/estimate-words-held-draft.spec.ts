import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * THE GIVEN-LONGER WORDS, A TEXT HELD FOR THE MORNING, AND A DRAFT PAST ITS DATE
 *
 * The words get their own screen: saved, read back, and a word the notice does
 * not know is refused in words. The estimate's page says a text is waiting for
 * the morning, and that a draft ran out before it was ever sent. The worker
 * that makes both true is tested against the database; here the rows it writes
 * are put in place, so the screen is what is under test.
 */
const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("the office words the given-longer message on its own screen", async ({ owner }) => {
  await owner.goto("/estimates/given-longer");
  await expect(owner.getByRole("heading", { level: 1, name: "Words for giving longer" })).toBeVisible();
  const text = owner.getByLabel("Text message");
  await text.fill(`Good news {{ customer.firstName }}: your price is held to {{ estimate.expiresOn }}. ${run}`);
  await owner.getByRole("button", { name: "Save the words" }).click();
  await expect(owner.getByRole("status")).toContainText("Saved.");
  await owner.reload();
  await expect(owner.getByLabel("Text message")).toHaveValue(new RegExp(`your price is held to .* ${run}$`));

  // A word the notice does not know would reach a customer as a gap.
  await owner.getByLabel("Text message").fill("Held until {{ invoice.total }}.");
  await owner.getByRole("button", { name: "Save the words" }).click();
  await expect(owner.getByRole("alert")).toBeVisible();
});

test("the estimate's page says a text is waiting for the morning, and that a draft ran out before it was sent", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Hollis Held ${run}`, phone: "512-555-0166",
    address: { street: "9 Held Hollow", city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const write = async (title: string) => {
    const made = await owner.request.post("/api/v1/estimates", {
      data: {
        customerId, propertyId, title, expiresOn: plus(companyToday(), 3),
        options: [{ name: "Replace", isRecommended: true, lines: [{ name: "Heater", quantity: "1", unitPrice: "900.00", discountAmount: "0", taxable: false }] }],
      },
    });
    expect(made.ok()).toBe(true);
    return ((await made.json()) as { id: string }).id;
  };
  const waiting = await write(`Held text ${run}`);
  expect((await owner.request.post(`/api/v1/estimates/${waiting}/send`, { data: { channel: "link" } })).ok()).toBe(true);
  const draft = await write(`Ran out ${run}`);

  const db = createClient();
  try {
    await db.insert(schema.estimateHeldText).values({
      organizationId: E2E_ORGANIZATION_ID, estimateId: waiting, note: "Good news.",
      expiresOn: plus(companyToday(), 3), linkUntil: new Date(Date.now() + 864e5),
    });
    await db.update(schema.estimate).set({ status: "expired", expiredAsDraftAt: new Date(), expiresOn: plus(companyToday(), -2) })
      .where(and(eq(schema.estimate.id, draft), eq(schema.estimate.organizationId, E2E_ORGANIZATION_ID)));
  } finally {
    await db.$close();
  }

  await owner.goto(`/estimates/${waiting}`);
  await expect(owner.getByRole("region", { name: "Text held for the morning" })).toContainText("waiting for the morning");

  await owner.goto(`/estimates/${draft}`);
  await expect(owner.getByRole("note")).toContainText("ran out before it was ever sent");
  // Nobody has it, so there is nobody to give longer.
  await expect(owner.getByText("Give them longer to answer")).toHaveCount(0);
});
