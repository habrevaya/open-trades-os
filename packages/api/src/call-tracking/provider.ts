import { adapterSettings } from "../secrets/endpoints";

/**
 * THE CALL TRACKING SEAM
 *
 * Call tracking is the only way most of a trades company's marketing is
 * measured at all. A yard sign, a van, a fridge magnet, a mailer and a radio
 * spot carry no query string and set no referrer; the NUMBER is the tag.
 * `marketing_touch` was built for exactly this and the only thing that ever
 * wrote a tracked call into it was `telephony.logCall`, which is reached
 * from a user's session.
 *
 * A provider here answers three questions and nothing else:
 *
 *   Did this delivery really come from them?
 *   What call does this body describe?
 *   What calls happened between these two times?
 *
 * The third exists because of a property shared by every vendor in this
 * space and stated plainly by the one implemented: webhooks are not resent.
 * A delivery that fails is a call that is simply missing, and the only
 * remedy is to go and ask. A seam with no way to ask would make an outage
 * permanent.
 */

export interface WebhookRequest {
  /** The raw body, exactly as received. Re-serializing breaks every signature. */
  body: string;
  headers: Record<string, string>;
}

/**
 * WHAT A PROVIDER CAN ACTUALLY PROVE ABOUT A DELIVERY, AS A VALUE.
 *
 * Not a `verify()` that some adapters implement honestly and others
 * implement as `return true`. That shape is how a product ends up with an
 * endpoint whose security everybody believes in because there is a function
 * called verify on the way in.
 *
 * A provider that signs its deliveries declares `signature` and supplies the
 * check. A provider that does not declares `unguessable_url`, says why in
 * its own words, and the endpoint's safety is then exactly the secrecy of
 * the token in its path, which the route and the catalogue both have to say
 * out loud.
 */
export type WebhookProof =
  | {
      kind: "signature";
      /** The header the signature arrives in, lower case. */
      header: string;
      /** In one line, for the setup screen: what the operator has to go and copy. */
      secretIs: string;
      verify(request: WebhookRequest, secret: string, now?: () => number): boolean;
    }
  | {
      kind: "unguessable_url";
      /** Why there is nothing better. Shown in the connector catalogue's limitation. */
      why: string;
    };

/** One tracked call, normalized. Providers disagree about nearly every field name. */
export interface TrackedCall {
  /** Their id for the call. The thing that makes a resend the same call. */
  externalId: string;
  direction: "inbound" | "outbound";
  /** The number the customer dialled, which IS the marketing tag. */
  trackingNumber: string;
  /** The customer's own number. */
  customerNumber: string;
  /** Where the call was actually answered, when they say. */
  businessNumber: string | null;
  startedAt: Date;
  durationSeconds: number | null;
  answered: boolean;
  voicemail: boolean;
  customerName: string | null;
  /**
   * Their attribution, verbatim and unmapped. Deliberately not forced into
   * this product's own closed source catalogue by the adapter: these are
   * free text on their side, and an adapter guessing which of our keys
   * "Google Organic" means is how a whole channel lands under the wrong one.
   * The service turns them into a touch through the same parser a website
   * visit goes through.
   */
  utm: {
    source?: string | undefined;
    medium?: string | undefined;
    campaign?: string | undefined;
    term?: string | undefined;
    content?: string | undefined;
  };
  clickId: string | null;
  referrer: string | null;
  landingPath: string | null;
  /** Their id for the person across calls, forms and texts, when they have one. */
  personId: string | null;
  /** Whether this is the first time this caller has ever rung. */
  firstCall: boolean | null;
  /** Everything they sent, kept whole, because a field map is always wrong about something. */
  raw: Record<string, unknown>;
}

export interface CallTrackingProvider {
  readonly name: string;
  readonly proof: WebhookProof;
  /**
   * What this body describes, or null if it is not a call this can use.
   *
   * Returns null rather than throwing for the shapes a provider sends that
   * are not calls at all: a text message, a form submission. The endpoint
   * answers 200 to those, because a provider that treats a non-2xx as a
   * failure will either retry forever or disable the integration.
   */
  parseCall(request: WebhookRequest): TrackedCall | null;
  /**
   * Calls in a window, for backfilling what a failed delivery lost.
   *
   * Paged, because the window somebody backfills after an outage is a day
   * rather than an hour. `hasMore` is the provider's own answer rather than
   * an inference from the page being full, since a page that happens to be
   * exactly full is not evidence of anything.
   */
  listCalls(window: {
    since: Date; until: Date; page: number;
  }): Promise<CallFetch>;
  /** Whether the credential works at all, and whose account it is. For the setup screen. */
  checkCredential(): Promise<CredentialCheck>;
}

export type CallFetch =
  | { ok: true; calls: TrackedCall[]; page: number; hasMore: boolean }
  | { ok: false; code: string; message: string; retryable: boolean };

export type CredentialCheck =
  | { ok: true; accountId: string; accountName: string }
  | { ok: false; code: string; message: string; retryable: boolean };

export class CallTrackingProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No call tracking provider configured for "${provider}"`);
    this.name = "CallTrackingProviderNotConfiguredError";
  }
}

const registry = new Map<
  string,
  (settings: Record<string, unknown>, secret: string) => CallTrackingProvider
>();

export function registerCallTrackingProvider(
  name: string,
  factory: (settings: Record<string, unknown>, secret: string) => CallTrackingProvider,
): void {
  registry.set(name, factory);
}

export function createCallTrackingProvider(
  name: string,
  settings: Record<string, unknown>,
  secret: string,
): CallTrackingProvider {
  const factory = registry.get(name);
  if (!factory) throw new CallTrackingProviderNotConfiguredError(name);
  // Never a stored endpoint override: see `adapterSettings`.
  return factory(adapterSettings(name, settings), secret);
}

export const registeredCallTrackingProviders = (): string[] => [...registry.keys()];
