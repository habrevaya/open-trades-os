import { createHash, timingSafeEqual } from "node:crypto";
import type { HttpTransport } from "../accounting/provider";
import type { InboundLead } from "../marketing/provider";

export type { HttpTransport };
export { PlatformRefusedError, PlatformUnavailableError, AuthorizationLostError } from "../ads/provider";

/**
 * THE LEAD MARKETPLACE SEAM
 *
 * Angi, Thumbtack and Yelp each post to the same lead endpoint as the generic
 * webhook, and each is verified and read its own way: the generic webhook is
 * an HMAC over the body, Angi and Thumbtack post with a password the company
 * chose, and Yelp posts only an id that is then read back from Yelp. What the
 * service does with the result is the same for all of them: a lead becomes an
 * offer in the lead inbox, credited to the connector's channel and campaign,
 * and a message becomes a line in the lead's thread.
 *
 * AN ADAPTER NEVER TOUCHES THE DATABASE, for the reason the ad platforms'
 * do not: crediting, deduplicating and recording what was sent stay in one
 * service rather than being trusted to three adapters.
 */

export type MarketplacePlatform = "angi" | "thumbtack" | "yelp";

export interface MarketplaceRequest {
  /** The public URL the platform posted to, from configuration. */
  url: string;
  method: string;
  /** Lower cased names. */
  headers: Record<string, string>;
  /** The raw body, exactly as it arrived. */
  body: string;
}

/** A lead as a marketplace hands it over, with what it charged. */
export interface MarketplaceLead extends InboundLead {
  /** What the platform charged for the lead, when it says, as an exact amount. */
  charge: string | null;
}

export interface MarketplaceMessage {
  /** The platform's id for the lead the message is on. */
  leadExternalId: string;
  /** The platform's id for the message itself. */
  externalId: string;
  body: string;
  at: Date;
  /** Who wrote it. A message the business wrote on the platform's own screen is kept as outbound. */
  from: "customer" | "business";
}

export type MarketplaceEvent =
  | { kind: "lead"; lead: MarketplaceLead }
  | { kind: "message"; message: MarketplaceMessage }
  /** Something happened on this lead; read it from the platform. */
  | { kind: "notice"; leadExternalId: string };

export interface Fetched {
  lead: MarketplaceLead;
  messages: MarketplaceMessage[];
}

export interface MarketplaceAdapter {
  readonly platform: MarketplacePlatform;
  /**
   * Whether this request is the platform's. Required, and not a setting, for
   * the reason the generic webhook gives: an unverified lead endpoint is a
   * job creation API on the open internet.
   */
  verify(request: MarketplaceRequest): boolean;
  /** What the request says happened, or null for a body this cannot read. */
  parse(request: MarketplaceRequest): MarketplaceEvent[] | null;
  /** The lead and its messages, read from the platform, for one that posts only an id. */
  fetchLead?(leadExternalId: string): Promise<Fetched | null>;
  /** A reply, through the platform, to the customer on a lead. */
  sendMessage?(leadExternalId: string, text: string): Promise<{ externalId: string | null }>;
}

export interface MarketplaceInput {
  /** The connection's settings: the business id, and the test only base url. */
  settings: Record<string, unknown>;
  /** The password the platform posts with, from the secret store. Null when none is configured. */
  webhookSecret: string | null;
  /** The token the platform's API is spoken to with, from the secret store. */
  apiToken: string | null;
  transport: HttpTransport;
}

const registry = new Map<string, (input: MarketplaceInput) => MarketplaceAdapter>();

export function registerMarketplace(platform: MarketplacePlatform, factory: (input: MarketplaceInput) => MarketplaceAdapter): void {
  registry.set(platform, factory);
}

export function createMarketplace(platform: string, input: MarketplaceInput): MarketplaceAdapter {
  const factory = registry.get(platform);
  if (!factory) throw new Error(`No lead marketplace adapter registered for "${platform}"`);
  return factory(input);
}

/** Read by the catalogue test: nothing may be `built` without an adapter here or in another registry. */
export const registeredMarketplaces = (): string[] => [...registry.keys()];

/* --------------------------------------------------------------- helpers */

export const textSetting = (settings: Record<string, unknown>, key: string): string | undefined => {
  const value = settings[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/**
 * Whether the request carries the company's password in HTTP Basic, in
 * constant time and over hashes, so neither the comparison's speed nor the
 * lengths say how close a wrong one was. The user name is not checked: the
 * platform's form asks for one and the password is the secret.
 */
export function basicPasswordMatches(headers: Record<string, string>, secret: string | null): boolean {
  if (!secret) return false;
  const header = headers["authorization"] ?? "";
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const given = createHash("sha256").update(decoded.slice(colon + 1)).digest();
  const wanted = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, wanted);
}

/** A parsed JSON object body, or null. */
export function objectBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export const str = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

/** An amount as the platform wrote it, exactly, or null for anything that is not one. */
export function amountOf(value: unknown): string | null {
  const text = str(value)?.replace(/^\$/, "").replace(/,/g, "");
  return text && /^\d+(\.\d+)?$/.test(text) ? text : null;
}

/** A moment from seconds since 1970 or an ISO string, or now. */
export function momentOf(value: unknown): Date {
  const text = str(value);
  if (text && /^\d{9,11}$/.test(text)) return new Date(Number(text) * 1000);
  const parsed = text ? new Date(text) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

/** A question and answer list, as notes a person reads. */
export function questionsAsNotes(list: unknown, q: string, a: string): string | null {
  const lines = (Array.isArray(list) ? list as Record<string, unknown>[] : [])
    .map((item) => {
      const answer = Array.isArray(item[a]) ? (item[a] as unknown[]).map(str).filter(Boolean).join(", ") : str(item[a]);
      const question = str(item[q]);
      return question && answer ? `${question}: ${answer}` : null;
    })
    .filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}
