import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AuthorizationLostError, PlatformRefusedError, PlatformUnavailableError, jsonOf, registerAdsAdapter, textSetting,
  type AdapterInput, type AdsAdapter, type PulledLead,
} from "./provider";

/**
 * META INSTANT FORMS (LEAD ADS)
 *
 * A Facebook or Instagram ad whose form is filled in without the person ever
 * reaching the website. The website snippet never sees them and no click id
 * comes back, so until now a company running these typed them in from Meta's
 * screen, or did not.
 *
 * Two ways in, one lead:
 *
 *   THE WEBHOOK. Meta posts `leadgen` for the Page the moment a form is
 *   submitted, signed with the app's secret, carrying the lead's id and
 *   nothing a person said. The lead is read from the Graph API with a Page
 *   token (`fetchLead`).
 *
 *   THE PULL, every ten minutes: the Page's forms and each form's leads since
 *   the last pull. A webhook Meta never sent, or sent while this deployment
 *   was down, is found here, and a lead found both ways is one lead, because
 *   both are keyed on Meta's lead id.
 *
 * The person's own token reads the Page's token (`/{page}?fields=access_token`),
 * which is what leads are read with: Meta answers a lead only to a Page token.
 * The Page is also subscribed to the app on each pull, which is what makes
 * Meta post at all and costs nothing when it already is.
 */

const DEFAULT_BASE = "https://graph.facebook.com";
const DEFAULT_VERSION = "v21.0";
const MAX_PAGES = 20;
const LEAD_FIELDS = "id,created_time,field_data,ad_id,ad_name,adset_id,campaign_id,campaign_name,form_id,platform";

/** Meta's header: `sha256=` and the hex HMAC of the exact body under the app's secret. */
export const META_SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * Whether a webhook body is Meta's, compared in constant time over the raw
 * bytes. A body parsed and serialised again has different bytes, so this is
 * called with what arrived and nothing else.
 */
export function verifyMetaSignature(body: string, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(body, "utf8").digest("hex")}`, "utf8");
  const provided = Buffer.from(header.trim(), "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function metaError(status: number, body: unknown): Error {
  const error = (body as { error?: { message?: unknown; code?: unknown } }).error ?? {};
  const words = typeof error.message === "string" ? error.message.slice(0, 300) : "";
  if (error.code === 190 || status === 401) return new AuthorizationLostError(`Meta no longer accepts this connection's sign in: ${words}`);
  if (status === 429 || status >= 500 || [4, 17, 32, 613].includes(Number(error.code))) {
    return new PlatformUnavailableError(`Meta answered HTTP ${status}: ${words} It will be tried again.`);
  }
  return new PlatformRefusedError(`Meta refused the request (HTTP ${status}): ${words}`);
}

/** A lead's answers by question name, first value of each. */
function answers(fieldData: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of Array.isArray(fieldData) ? fieldData as { name?: unknown; values?: unknown }[] : []) {
    if (typeof field.name !== "string" || !Array.isArray(field.values)) continue;
    const value = field.values.find((v) => typeof v === "string" && v.trim() !== "");
    if (typeof value === "string") out[field.name.toLowerCase()] = value.trim();
  }
  return out;
}

/** One lead as Meta returns it, into the shape every lead pull hands over. */
export function leadFromMeta(raw: Record<string, unknown>): PulledLead | null {
  if (typeof raw["id"] !== "string" && typeof raw["id"] !== "number") return null;
  const a = answers(raw["field_data"]);
  const pick = (...names: string[]) => names.map((n) => a[n]).find((v) => v !== undefined) ?? null;
  const name = pick("full_name", "name") ?? ([pick("first_name"), pick("last_name")].filter(Boolean).join(" ") || null);
  const created = typeof raw["created_time"] === "string" ? new Date(raw["created_time"]) : new Date();
  const campaignId = raw["campaign_id"];
  return {
    externalId: String(raw["id"]),
    type: "FORM",
    name,
    phone: pick("phone_number", "phone"),
    email: pick("email", "work_email"),
    service: pick("service", "what_service_do_you_need?", "what_do_you_need_help_with?"),
    createdAt: Number.isNaN(created.getTime()) ? new Date() : created,
    charged: null,
    address: {
      line1: pick("street_address", "address"),
      city: pick("city"),
      state: pick("state", "province"),
      postalCode: pick("zip_code", "post_code", "postal_code", "zip"),
    },
    campaign: typeof campaignId === "string" || typeof campaignId === "number"
      ? { id: String(campaignId), name: typeof raw["campaign_name"] === "string" ? raw["campaign_name"] : null }
      : null,
    raw,
  };
}

function createMetaLeadAds(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const version = textSetting(input.settings, "apiVersion") ?? DEFAULT_VERSION;
  const pageId = textSetting(input.settings, "pageId")?.replace(/\D/g, "") || undefined;
  let pageToken: string | null = null;

  async function get(url: string, token: string): Promise<unknown> {
    let response;
    try {
      response = await input.transport(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (error) {
      throw new PlatformUnavailableError(`Meta could not be reached: ${(error as Error).message}`);
    }
    const parsed = await jsonOf(response, "Meta");
    if (response.status < 200 || response.status >= 300) throw metaError(response.status, parsed);
    return parsed;
  }

  /** The Page's own token, read with the person's, once per adapter. */
  async function page(): Promise<{ id: string; token: string }> {
    if (!pageId) throw new PlatformRefusedError("Enter the id of the Facebook Page the instant forms run on.");
    if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Meta for this connection yet.");
    if (!pageToken) {
      const body = await get(`${base}/${version}/${pageId}?fields=access_token`, await input.token.accessToken()) as { access_token?: unknown };
      if (typeof body.access_token !== "string") {
        throw new PlatformRefusedError("Meta gave no token for that Page. The person who signed in has to be an admin of it, and grant the Page when Meta asks.");
      }
      pageToken = body.access_token;
    }
    return { id: pageId, token: pageToken };
  }

  return {
    provider: "meta_lead_ads",

    async fetchLead(externalId) {
      const { token } = await page();
      const id = externalId.replace(/[^0-9]/g, "");
      if (id === "") return null;
      const raw = await get(`${base}/${version}/${id}?fields=${LEAD_FIELDS}`, token) as Record<string, unknown>;
      return leadFromMeta(raw);
    },

    async pullLeads(since) {
      const { id, token } = await page();
      /** Subscribing the Page is what makes Meta post at all; refused without the scope, which the pull survives. */
      try {
        await input.transport(`${base}/${version}/${id}/subscribed_apps?subscribed_fields=leadgen`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
      } catch {
        /* Reading leads below still works without the subscription; only the speed is lost. */
      }
      const forms: string[] = [];
      let url: string | null = `${base}/${version}/${id}/leadgen_forms?fields=id,name&limit=100`;
      for (let n = 0; url && n < MAX_PAGES; n++) {
        const body = await get(url, token) as { data?: { id?: unknown }[]; paging?: { next?: unknown } };
        for (const form of body.data ?? []) if (typeof form.id === "string") forms.push(form.id);
        url = typeof body.paging?.next === "string" ? body.paging.next : null;
      }
      const filtering = JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since.getTime() / 1000) }]);
      const out: PulledLead[] = [];
      for (const form of forms) {
        let next: string | null = `${base}/${version}/${form}/leads?${new URLSearchParams({ fields: LEAD_FIELDS, filtering, limit: "100" }).toString()}`;
        for (let n = 0; next && n < MAX_PAGES; n++) {
          const body = await get(next, token) as { data?: Record<string, unknown>[]; paging?: { next?: unknown } };
          for (const raw of body.data ?? []) {
            const lead = leadFromMeta(raw);
            if (lead) out.push(lead);
          }
          next = typeof body.paging?.next === "string" ? body.paging.next : null;
        }
      }
      return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
  };
}

registerAdsAdapter("meta_lead_ads", createMetaLeadAds);
