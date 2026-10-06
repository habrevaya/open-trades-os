import type { ads } from "@opentradesos/core";
import type { HttpTransport } from "../accounting/provider";
import { adapterSettings } from "../secrets/endpoints";

export type { HttpTransport };

/**
 * THE AD PLATFORM SEAM
 *
 * One interface for five providers, because they move the same few things in
 * the same few directions: what a campaign cost on a day, a job told back to
 * the account that bought the click, a lead read out of an inbox, a review
 * read and a reply written. Each adapter implements the methods its platform
 * has and leaves the rest absent, and the service asks before it calls, so
 * "Google Business Profile has no spend" is a missing method rather than a
 * method that returns nothing and reads as a free month.
 *
 * AN ADAPTER NEVER TOUCHES THE DATABASE. It is handed a token source, the
 * settings and the secrets it needs, and an HTTP transport, and it returns
 * rows. Mapping campaigns, writing spend, deciding consent and recording
 * every send all stay in the services, in one place, rather than being
 * trusted to five adapters that will each get one of them slightly wrong.
 *
 * Over `fetch`, no SDKs, for the reason the accounting and messaging
 * adapters give: a self hoster auditing what leaves their network should be
 * able to read one file per platform, and the transport is a parameter so
 * every test runs against a fake.
 */

/** A live access token, fetched or refreshed as needed. */
export interface TokenSource {
  accessToken(): Promise<string>;
}

/**
 * The grant is gone: revoked by the person, expired, or never valid.
 *
 * Its own error because it needs a PERSON, and nothing else here does. A
 * platform being down is retried; a refused conversion is recorded; this
 * marks the connection as needing somebody to sign in again and stops every
 * pull for it until they do, because hammering a token endpoint with a dead
 * refresh token is how a client id gets rate limited for every company on
 * the deployment.
 */
export class AuthorizationLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationLostError";
  }
}

/**
 * The platform looked at the request and said no, with its own words.
 *
 * Not retried by itself. The same request gets the same answer, and a
 * request retried forever is a queue that fills with the one thing nobody
 * will ever fix by waiting.
 */
export class PlatformRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformRefusedError";
  }
}

/** It did not get there, or the platform was not answering. Retried later. */
export class PlatformUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformUnavailableError";
  }
}

export interface PulledSpend {
  /** The ad account: a Google Ads customer id, a Meta ad account id. */
  accountId: string;
  campaignId: string;
  campaignName: string;
  /** Google's advertising channel type; null where the platform has none. */
  channelType: string | null;
  /** The day, in the ad account's own timezone, as the platform reports it. */
  day: string;
  /** Exact, at four places, in the account's currency. Never a float. */
  amount: string;
  impressions: number | null;
  clicks: number | null;
  currency: string;
}

/** One thing a platform is told about one job. */
export interface OutboundEvent {
  /** The same on every attempt, so the platform deduplicates a repeat. */
  eventId: string;
  kind: ads.EventKind;
  at: Date;
  /** This platform's share of the job's revenue, for a purchase. */
  value: string | null;
  currency: string;
  /** The click id, and which parameter carried it. */
  clickId: string | null;
  clickParam: string | null;
  /** When the click was first seen, which Meta writes into its click parameter. */
  clickSeenAt: Date | null;
  /** Already normalised the platform's way and hashed. Null when not allowed or not known. */
  hashedEmail: string | null;
  hashedPhone: string | null;
  /** Google Analytics' client id. */
  clientId: string | null;
  /** Meta's `_fbp` browser id. */
  browserId: string | null;
  adUserData: "GRANTED" | "DENIED";
}

export type EventOutcome =
  | { eventId: string; ok: true }
  /** The platform refused this one event, with its words. The rest of the batch may have gone. */
  | { eventId: string; ok: false; message: string };

export interface PulledLead {
  /** The platform's own lead id, which makes a second read of it the same lead. */
  externalId: string;
  /** PHONE_CALL, MESSAGE or BOOKING for Local Services. */
  type: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  /** What they asked for, as the platform words it. */
  service: string | null;
  createdAt: Date;
  /** Whether the platform charged for it, which is spend and a lead at once. */
  charged: boolean | null;
  /** Where they are, when the platform asked them. */
  address?: { line1: string | null; city: string | null; state: string | null; postalCode: string | null } | undefined;
  /** The platform's campaign the lead came from, which is what credits it to a tracking campaign. */
  campaign?: { id: string; name: string | null } | null | undefined;
  raw: Record<string, unknown>;
}

/**
 * One day of behaviour read back: a search query from Search Console, or the
 * sessions from one source and medium from Google Analytics.
 */
export type PulledAnalytics =
  | { kind: "search"; day: string; query: string; clicks: number; impressions: number; position: string | null }
  | { kind: "sessions"; day: string; source: string; medium: string; sessions: number; engagedSessions: number };

/** One change to a purchase already sent: a new value, or none at all. */
export interface OutboundAdjustment {
  /** The order id the original conversion carried, which is what Google finds it by. */
  orderId: string;
  kind: "restatement" | "retraction";
  /** The new value, for a restatement. */
  value: string | null;
  currency: string;
  at: Date;
}

export interface PulledReview {
  /** The platform's full name for it, which a reply is posted to. */
  externalId: string;
  authorName: string | null;
  rating: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** A reply already on the platform, whoever wrote it. */
  reply: { comment: string; updatedAt: Date } | null;
}

export interface AdsAdapter {
  readonly provider: ads.AdsProvider;
  /** Every campaign's cost per day over the range, inclusive. */
  pullSpend?(range: { from: string; to: string }): Promise<PulledSpend[]>;
  /** Tell the platform about these events. One outcome per event, in order. */
  sendEvents?(events: OutboundEvent[]): Promise<EventOutcome[]>;
  /** Leads created since a moment. */
  pullLeads?(since: Date): Promise<PulledLead[]>;
  /** One lead by the platform's id, for a platform that posts only that one arrived. */
  fetchLead?(externalId: string): Promise<PulledLead | null>;
  /** Search queries or sessions per day over the range, inclusive. */
  pullAnalytics?(range: { from: string; to: string }): Promise<PulledAnalytics[]>;
  /** Restate or retract purchases already sent. One outcome per adjustment, in order, keyed by order id. */
  adjustConversions?(adjustments: OutboundAdjustment[]): Promise<{ orderId: string; ok: boolean; message: string | null }[]>;
  /** Every review on the listing, newest first. */
  listReviews?(): Promise<PulledReview[]>;
  /** Post a reply, or replace the one there. */
  postReply?(externalId: string, comment: string): Promise<{ postedAt: Date }>;
}

export interface AdapterInput {
  /** The connection's settings: account ids, and the test only base urls. */
  settings: Record<string, unknown>;
  /** Null for a provider with no sign in, which is GA4. */
  token: TokenSource | null;
  /** Secrets the adapter sends itself: a developer token, an API secret. Resolved by the service. */
  secrets: Readonly<Record<string, string>>;
  transport: HttpTransport;
}

export class AdapterNotRegisteredError extends Error {
  constructor(provider: string) {
    super(`No ad platform adapter registered for "${provider}"`);
    this.name = "AdapterNotRegisteredError";
  }
}

const registry = new Map<string, (input: AdapterInput) => AdsAdapter>();

export function registerAdsAdapter(provider: ads.AdsProvider, factory: (input: AdapterInput) => AdsAdapter): void {
  registry.set(provider, factory);
}

export function createAdsAdapter(provider: string, input: AdapterInput): AdsAdapter {
  const factory = registry.get(provider);
  if (!factory) throw new AdapterNotRegisteredError(provider);
  // Never a stored endpoint override: see `adapterSettings`.
  return factory({ ...input, settings: adapterSettings(provider, input.settings) });
}

/** Read by the catalogue test: nothing may be `built` without an adapter here. */
export const registeredAdsAdapters = (): string[] => [...registry.keys()];

/* --------------------------------------------------------------- helpers */

/** A setting as text, or undefined. */
export const textSetting = (settings: Record<string, unknown>, key: string): string | undefined => {
  const value = settings[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/**
 * Read a response body as JSON, or say what came back instead.
 *
 * A proxy's HTML error page, an empty body on a 502: an adapter that
 * `JSON.parse`s blindly throws a syntax error that names neither the
 * platform nor the status, and the screen says "Unexpected token <".
 */
export async function jsonOf(response: { status: number; text(): Promise<string> }, platform: string): Promise<unknown> {
  const body = await response.text();
  if (body.trim() === "") return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PlatformUnavailableError(`${platform} answered HTTP ${response.status} with something that is not JSON.`);
  }
}

/**
 * The status code, sorted into what to do about it.
 *
 * 401 is the grant; 429 and every 5xx are "later"; any other 4xx is the
 * platform refusing this request, and its words are kept, clipped, because
 * "INVALID_CONVERSION_ACTION" is the sentence that tells an operator which
 * setting to fix.
 */
export function failure(status: number, platform: string, message: string): Error {
  const words = message.slice(0, 400);
  if (status === 401) return new AuthorizationLostError(`${platform} no longer accepts this connection's sign in: ${words}`);
  if (status === 429 || status >= 500) {
    return new PlatformUnavailableError(`${platform} answered HTTP ${status}${words ? `: ${words}` : ""}. It will be tried again.`);
  }
  return new PlatformRefusedError(`${platform} refused the request (HTTP ${status})${words ? `: ${words}` : ""}`);
}
