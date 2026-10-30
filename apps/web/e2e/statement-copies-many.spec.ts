import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * A STATEMENT COPIED TO SEVERAL PEOPLE, BY TEXT AS WELL AS EMAIL, AND TO AN ADDRESS TYPED (M13)
 *
 * The office adds two of a property manager's people, emails the manager's
 * statement and ticks one for an email copy and the other for a text copy,
 * then types a third address. Each copy is said on the page and in the list
 * of statements sent, the typed one marked as typed.
 *
 * An email connection is written for the length of the spec and taken away
 * after, as the single copy spec does; nothing leaves the machine.
 */
async function connectEmail(): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.insert(schema.integrationConnection).values({
      organizationId: E2E_ORGANIZATION_ID, capability: "email", provider: "smtp", status: "connected",
      accountLabel: "Copies spec", settings: { fromAddress: "office@e2e.test" },
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

test("a statement copied to two of the customer's people, by email and by text, and to a typed address", async ({ owner }) => {
  const address = `ap+${run}@example.test`;
  const clerk = `Cora Clerk ${run}`;
  const boss = `Otto Owner ${run}`;
  const id = await newCustomer(owner, { name: `Harbor Management ${run}`, email: address });

  for (const [name, mail, phone] of [[clerk, `cora+${run}@example.test`, "512-555-0171"], [boss, `otto+${run}@example.test`, "512-555-0172"]] as const) {
    // The form stays open after an add, with its button saying Cancel.
    const open = owner.getByRole("button", { name: "Add somebody" });
    if (await open.isVisible()) await open.click();
    await owner.locator("#c-name").fill(name);
    await owner.locator("#c-email").fill(mail);
    await owner.locator("#c-phone").fill(phone);
    await owner.locator("#c-channel").selectOption({ label: "Email" });
    await owner.getByRole("button", { name: "Add", exact: true }).click();
    await expect(owner.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  }

  const connection = await connectEmail();
  try {
    await owner.goto(`/customers/${id}/statement`);
    const panel = owner.getByRole("region", { name: "Email statement" });
    const copies = panel.getByRole("group", { name: "Also copy the emailed statement to" });
    await copies.getByLabel(`Email a copy to ${clerk}`).check();
    await copies.getByLabel(`Text a copy to ${boss}`).check();
    await copies.getByLabel("Another address or number").fill(`books+${run}@example.net`);
    await panel.getByRole("button", { name: "Email statement" }).click();

    const said = panel.getByRole("status").filter({ hasText: `Emailed a link to ${address}.` });
    await expect(said).toContainText(`A copy goes to ${clerk} at cora+${run}@example.test.`);
    await expect(said).toContainText(`A text copy goes to ${boss} at`);
    await expect(said).toContainText(`A copy goes to books+${run}@example.net.`);

    const list = panel.getByRole("list", { name: "Statements already sent" });
    await expect(list).toContainText(`Copy to ${clerk} at cora+${run}@example.test`);
    await expect(list).toContainText(`Text copy to ${boss} at`);
    await expect(list).toContainText(`Copy to books+${run}@example.net`);
    await expect(list).toContainText("(typed by the office)");
  } finally {
    await disconnectEmail(connection);
  }
});
