import { getDb } from "@/lib/db";
import { leadIntake } from "@opentradesos/api/services";
import { schema } from "@opentradesos/db";
import { and, eq, isNull } from "drizzle-orm";
// Registers the marketing adapters.
import "@opentradesos/api/marketing";

export const dynamic = "force-dynamic";

/**
 * WHERE A LEAD ARRIVES
 *
 * One endpoint for every marketplace, form builder and partner, because what
 * differs between them is the field names and the signing, and both of those
 * belong to the adapter. A route per source would be this file eight times
 * with one import changed.
 *
 * THE TOKEN IN THE PATH IDENTIFIES THE CONNECTOR, AND THEREFORE THE TENANT.
 * It is a secret, which is why it is not the company slug: a slug is on
 * their website, and using it to route would let anybody aim a forged lead
 * at a company they chose.
 *
 * A FORGED LEAD IS NOT A SPAM PROBLEM. It is a job on a dispatch board, a
 * slot a real customer could have had, and a van driving to an address that
 * never asked for one. That is why the signature check below has no setting
 * that disables it and no path around it.
 */

/**
 * The URL the signature is computed over.
 *
 * From configuration, not from the request. Behind a load balancer or a
 * tunnel the request arrives as http on an internal hostname, and rebuilding
 * the URL from `Host` and `X-Forwarded-Proto` means an attacker who can set
 * those chooses what gets signed, which turns the check into decoration.
 */
function publicUrl(token: string): string {
  const base = process.env["PUBLIC_URL"];
  if (!base) {
    throw new Error("PUBLIC_URL is not set. The webhook signature is computed over it.");
  }
  return `${base.replace(/\/$/, "")}/api/webhooks/leads/${token}`;
}

const readSecret = (ref: string): string => {
  const value = process.env[ref];
  if (!value) throw new Error(`No secret in the environment for "${ref}"`);
  return value;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const db = getDb();

  /**
   * The raw body, read once and never re-serialized. Parsing it to an object
   * and stringifying it back changes one byte of whitespace and every
   * signature stops matching, which presents as "the secret is wrong" and
   * costs an afternoon.
   */
  const body = await request.text();

  /**
   * Resolved OUTSIDE any tenant transaction, because at this point there is
   * no tenant: the token is what establishes one. Read with the service
   * role and nothing else about the request is trusted until the signature
   * has been checked.
   */
  const [connector] = await db.select({
    id: schema.leadSourceConnector.id,
    organizationId: schema.leadSourceConnector.organizationId,
    source: schema.leadSourceConnector.source,
    connectionId: schema.leadSourceConnector.connectionId,
    active: schema.leadSourceConnector.active,
  }).from(schema.leadSourceConnector)
    .where(and(
      eq(schema.leadSourceConnector.webhookToken, token),
      isNull(schema.leadSourceConnector.deletedAt),
    )).limit(1);

  /**
   * An unknown token and an inactive connector answer the same 404.
   * Distinguishing them would let somebody test tokens against the
   * difference, and a marketplace that has genuinely been turned off does
   * not need a more informative error than "not here".
   */
  if (!connector || !connector.active) {
    return new Response("Not found", { status: 404 });
  }

  const [connection] = connector.connectionId
    ? await db.select({ credentialRef: schema.integrationConnection.credentialRef, settings: schema.integrationConnection.settings })
      .from(schema.integrationConnection)
      .where(eq(schema.integrationConnection.id, connector.connectionId)).limit(1)
    : [];

  if (!connection?.credentialRef) {
    /**
     * A connector with no signing secret cannot verify anything, so it
     * refuses rather than accepting unsigned leads. The alternative is an
     * endpoint whose security depends on somebody having finished the setup.
     */
    return new Response("Not configured", { status: 409 });
  }

  const adapter = leadIntake.createLeadSource("lead_webhook");
  const webhookRequest = {
    url: publicUrl(token),
    headers: Object.fromEntries(
      [...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
    ),
    body,
  };

  if (!adapter.verify(webhookRequest, readSecret(connection.credentialRef))) {
    return new Response("Bad signature", { status: 401 });
  }

  const lead = adapter.parse(webhookRequest);
  if (!lead) {
    /**
     * 422 rather than 400, and deliberately not a 500. A body this cannot
     * read will fail identically on every retry, so an error status that
     * invites one is pure noise that ends with the sender disabling the
     * endpoint.
     */
    return Response.json(
      { error: "That lead has no name, or no phone number and no email, so there is nobody to call." },
      { status: 422 },
    );
  }

  const outcome = await leadIntake.receiveLead(db, {
    connectorId: connector.id,
    organizationId: connector.organizationId,
    lead: { ...lead, source: connector.source },
  });

  return Response.json(
    { received: true, offerId: outcome.offerId, duplicate: outcome.duplicate },
    { status: outcome.duplicate ? 200 : 201 },
  );
}
