import { createClient, schema } from "@opentradesos/db";
import { and, desc, eq, like } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * A COPY TO A TYPED ADDRESS OPENS THE STATEMENT AND NOTHING ELSE (M13)
 *
 * The office emails a customer's statement with a copy to an address it types.
 * The copy carries a link of its own: the person holding it sees that statement
 * and its PDF, with no way into the customer's account, and the same token is
 * no key to the account page. The office stops the link from the statement
 * page, and it opens nothing after.
 *
 * An email connection is written for the length of the spec and taken away
 * after, because the seeded company has none and a statement that cannot be
 * queued sends no copy. Nothing leaves the machine.
 */
async function connectEmail(): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.insert(schema.integrationConnection).values({
      organizationId: E2E_ORGANIZATION_ID, capability: "email", provider: "smtp", status: "connected",
      accountLabel: "Statement link spec", settings: { fromAddress: "office@e2e.test" },
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

/** The body of the newest email queued to one address. */
async function lastEmailTo(address: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.select({ body: schema.message.body }).from(schema.message)
      .where(and(eq(schema.message.organizationId, E2E_ORGANIZATION_ID), like(schema.message.toAddress, address)))
      .orderBy(desc(schema.message.createdAt)).limit(1);
    if (!row) throw new Error(`Nothing was queued to ${address}.`);
    return row.body ?? "";
  } finally {
    await db.$close();
  }
}

test("a typed copy's link opens the statement only, and stops when the office stops it", async ({ owner, stranger }) => {
  const name = `Lakeside Offices ${run}`;
  const typed = `books+${run}@example.net`;
  const id = await newCustomer(owner, { name, email: `ap+${run}@example.test` });

  const connection = await connectEmail();
  let token = "";
  try {
    await owner.goto(`/customers/${id}/statement`);
    const panel = owner.getByRole("region", { name: "Email statement" });
    const copies = panel.getByRole("group", { name: "Also copy the emailed statement to" });
    await expect(copies).toContainText("An address you type gets a link that opens this statement and nothing else");
    await copies.getByLabel("Another address or number").fill(typed);
    await panel.getByRole("button", { name: "Email statement" }).click();
    await expect(panel.getByRole("status").filter({ hasText: `A copy goes to ${typed}.` })).toBeVisible();

    const body = await lastEmailTo(typed);
    expect(body).toContain("The link opens this statement and nothing else, until ");
    expect(body).not.toMatch(/\/c\//);
    token = body.match(/\/s\/([A-Za-z0-9_-]+)/)![1]!;

    /* The holder sees the statement and its PDF, and nothing that leads into the account. */
    await stranger.goto(`/s/${token}`);
    await expect(stranger.getByRole("heading", { name: `Statement for ${name}` })).toBeVisible();
    await expect(stranger.getByText(`A copy of ${name}'s statement. This link opens it until`)).toBeVisible();
    await expect(stranger.getByRole("link", { name: "Back to your account" })).toHaveCount(0);
    const pdf = await stranger.request.get(`/s/${token}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");

    /* The same token is no key to the account page, its statement or its files. */
    expect((await stranger.request.get(`/c/${token}`)).status()).toBe(404);
    expect((await stranger.request.get(`/c/${token}/statement`)).status()).toBe(404);
    expect((await stranger.request.get(`/c/${token}/statement/pdf`)).status()).toBe(404);

    /* The office stops it. */
    const list = panel.getByRole("list", { name: "Statements already sent" });
    await expect(list).toContainText("Its link opens this statement only, until");
    await list.getByRole("button", { name: "Stop this link" }).click();
    await expect(list).toContainText("Its link was stopped.");
  } finally {
    await disconnectEmail(connection);
  }

  expect((await stranger.request.get(`/s/${token}`)).status()).toBe(404);
  expect((await stranger.request.get(`/s/${token}/pdf`)).status()).toBe(404);
});
