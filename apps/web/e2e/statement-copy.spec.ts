import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * A STATEMENT COPIED TO A SECOND PERSON (M13)
 *
 * The office adds the owner of a property manager as one of its people, emails
 * the manager's statement and copies the owner, chosen from the customer's own
 * list, then names the owner for a copy of every monthly statement.
 *
 * An email connection is written for the length of the spec and taken away
 * after, because the seeded company has none and a statement that cannot be
 * queued sends no copy. Nothing leaves the machine: queueing writes the
 * outbox, and nothing in the suite sends it.
 */
async function connectEmail(): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.insert(schema.integrationConnection).values({
      organizationId: E2E_ORGANIZATION_ID, capability: "email", provider: "smtp", status: "connected",
      accountLabel: "Copy spec", settings: { fromAddress: "office@e2e.test" },
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

test("a statement emailed with a copy to one of the customer's people, and the monthly copy named", async ({ owner }) => {
  const address = `ap+${run}@example.test`;
  const person = `Otto Owner ${run}`;
  const personAddress = `otto+${run}@example.test`;
  const id = await newCustomer(owner, { name: `Lakeside Management ${run}`, email: address });

  await owner.getByRole("button", { name: "Add somebody" }).click();
  await owner.locator("#c-name").fill(person);
  await owner.locator("#c-email").fill(personAddress);
  await owner.locator("#c-channel").selectOption({ label: "Email" });
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  await expect(owner.getByRole("listitem").filter({ hasText: person })).toBeVisible();

  const connection = await connectEmail();
  try {
    await owner.goto(`/customers/${id}/statement`);
    const panel = owner.getByRole("region", { name: "Email statement" });
    await panel.getByLabel("Also send a copy to").selectOption({ label: `${person} (${personAddress})` });
    await panel.getByRole("button", { name: "Email statement" }).click();
    await expect(panel.getByRole("status").filter({ hasText: `Emailed a link to ${address}.` }))
      .toContainText(`A copy goes to ${person} at ${personAddress}.`);
    await expect(panel.getByRole("list", { name: "Statements already sent" }))
      .toContainText(`Copy to ${person} at ${personAddress}`);

    // Every monthly statement copied to the same person, chosen from the same list.
    await expect(panel).toContainText("Copied to nobody.");
    await panel.getByLabel("Copy each monthly statement to").selectOption({ label: `${person} (${personAddress})` });
    await panel.getByRole("button", { name: "Save the monthly copy" }).click();
    await expect(panel.getByRole("status").filter({ hasText: `Saved. Each monthly statement is copied to ${person}.` })).toBeVisible();
    await expect(panel).toContainText(`Copied to ${person} (${personAddress}).`);
  } finally {
    await disconnectEmail(connection);
  }
});
