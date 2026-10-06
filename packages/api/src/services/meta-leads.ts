import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inTenant } from "./context";
import { adapterFor, adsActor, ingestLeads, type AdsDeps, type Connection } from "./ad-platforms";
import {
  AuthorizationLostError, PlatformUnavailableError, META_SIGNATURE_HEADER, parseOAuthClient, verifyMetaSignature,
  type PulledLead,
} from "../ads/index";
import { readerFor } from "../secrets/store";

/**
 * META'S WEBHOOK FOR INSTANT FORM LEADS
 *
 * A Meta app has ONE callback address for the Page object however many Pages
 * subscribe to it, so this is one endpoint for the whole deployment
 * (`/api/webhooks/meta/leads`) rather than a token per company. What decides
 * the company is the Page id in the post, matched against the Page each
 * company's connection names, and nothing is believed until the post's
 * signature has been checked with THAT connection's app secret: a post for a
 * Page nobody here has connected, or signed by another app, opens nothing.
 *
 * The post carries the lead's id and no answers. The lead is read back from
 * the Graph API with the Page's token and goes through the same intake the
 * ten minute pull uses, so a lead posted and pulled is one lead.
 *
 * Meta first checks the address with a GET carrying `hub.challenge`, answered
 * only when `hub.verify_token` is the deployment's own
 * (META_LEADS_VERIFY_TOKEN), which is configured in the app's dashboard.
 */

export const VERIFY_TOKEN_ENV = "META_LEADS_VERIFY_TOKEN";

/** The subscription check: the challenge back, or null for anything else. */
export function challenge(query: Record<string, string>, env: Record<string, string | undefined> = process.env): string | null {
  const expected = env[VERIFY_TOKEN_ENV];
  if (!expected || query["hub.mode"] !== "subscribe") return null;
  if (query["hub.verify_token"] !== expected) return null;
  const value = query["hub.challenge"];
  return value && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
}

interface Posted { pageId: string; leadIds: string[] }

/** The Pages and lead ids in a post, or null for a body that is not Meta's shape. */
function postedLeads(body: string): Posted[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  const value = parsed as { object?: unknown; entry?: unknown };
  if (value.object !== "page" || !Array.isArray(value.entry)) return null;
  const byPage = new Map<string, Set<string>>();
  for (const entry of value.entry as { id?: unknown; changes?: unknown }[]) {
    for (const change of Array.isArray(entry.changes) ? entry.changes as { field?: unknown; value?: Record<string, unknown> }[] : []) {
      if (change.field !== "leadgen" || !change.value) continue;
      const page = String(change.value["page_id"] ?? entry.id ?? "").replace(/\D/g, "");
      const lead = String(change.value["leadgen_id"] ?? "").replace(/\D/g, "");
      if (!page || !lead) continue;
      byPage.set(page, (byPage.get(page) ?? new Set()).add(lead));
    }
  }
  return [...byPage.entries()].map(([pageId, ids]) => ({ pageId, leadIds: [...ids] }));
}

export interface MetaWebhookAnswer { status: number; body: Record<string, unknown> }

export async function receive(
  db: Database, input: { headers: Record<string, string>; body: string }, deps: AdsDeps = {},
): Promise<MetaWebhookAnswer> {
  const posted = postedLeads(input.body);
  if (!posted) return { status: 422, body: { error: "not_a_leadgen_post" } };
  if (posted.length === 0) return { status: 200, body: { received: true, leads: 0 } };

  /**
   * Resolved before any company is known, by the Page id, as every webhook
   * here resolves its tenant from what it was sent; only connections that
   * are signed in are candidates.
   */
  const candidates = await db.select().from(schema.integrationConnection).where(and(
    eq(schema.integrationConnection.provider, "meta_lead_ads"),
    eq(schema.integrationConnection.status, "connected"),
    isNull(schema.integrationConnection.deletedAt),
    sql`regexp_replace(${schema.integrationConnection.settings} ->> 'pageId', '[^0-9]', '', 'g') in (${sql.join(posted.map((p) => sql`${p.pageId}`), sql`, `)})`,
  ));

  const verified: Connection[] = [];
  for (const row of candidates) {
    const ref = (row.settings as Record<string, unknown> | null)?.["oauthClientRef"];
    if (typeof ref !== "string") continue;
    try {
      // Each candidate's own company's secret, never a variable with the bare name.
      const client = parseOAuthClient(await (deps.readSecret ?? readerFor(db, row.organizationId))(ref));
      if (verifyMetaSignature(input.body, input.headers[META_SIGNATURE_HEADER], client.clientSecret)) verified.push(row);
    } catch {
      /* A connection whose app secret cannot be read cannot vouch for anything. */
    }
  }
  if (verified.length === 0) return { status: candidates.length === 0 ? 404 : 401, body: { error: candidates.length === 0 ? "unknown_page" : "bad_signature" } };

  let leads = 0;
  for (const row of verified) {
    const pageId = String((row.settings as Record<string, unknown>)["pageId"] ?? "").replace(/\D/g, "");
    const ids = posted.find((p) => p.pageId === pageId)?.leadIds ?? [];
    try {
      const adapter = await adapterFor(db, row, deps);
      const fetched: PulledLead[] = [];
      for (const id of ids) {
        const lead = await adapter.fetchLead?.(id);
        if (lead) fetched.push(lead);
      }
      const { written } = await inTenant({ actor: adsActor(row.organizationId), db }, (tx) => ingestLeads(tx, row, fetched));
      leads += written;
    } catch (error) {
      /**
       * Meta posts again when it is not answered with a 2xx, for a day and a
       * half, which is the remedy for Meta or this deployment having a bad
       * minute. A refused read is not: the ten minute pull will meet the
       * same refusal and say so on the Ad platforms screen.
       */
      if (error instanceof PlatformUnavailableError) return { status: 503, body: { error: "meta_unavailable" } };
      await inTenant({ actor: adsActor(row.organizationId), db }, (tx) =>
        tx.update(schema.integrationConnection).set({
          lastError: (error as Error).message.slice(0, 1000),
          lastCheckedAt: new Date(),
          ...(error instanceof AuthorizationLostError ? { status: "needs_reauth" as const } : {}),
        }).where(eq(schema.integrationConnection.id, row.id)));
    }
  }
  return { status: 200, body: { received: true, leads } };
}
