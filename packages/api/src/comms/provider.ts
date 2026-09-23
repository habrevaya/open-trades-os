/**
 * THE PROVIDER SEAM
 *
 * A contractor self hosting this must be able to point it at whichever carrier
 * they already pay, and must be able to leave. So the product knows about
 * "send this text" and nothing about Twilio, and a provider is roughly eighty
 * lines: send, verify a webhook, parse what arrives.
 *
 * Two things are deliberately NOT the provider's business.
 *
 * CONSENT is decided before a provider is chosen. A carrier's own opt out
 * handling is a courtesy, not a compliance position, and it does not know
 * about the consent a customer gave on a form in 2024. The decision lives in
 * core and the provider is told what to send, never asked whether to.
 *
 * THREADING is decided by us. Providers thread by phone number pair, which is
 * wrong the moment a customer moves house or a company uses a sending pool.
 */

export type ProviderChannel = "sms" | "mms";

export interface OutboundMessage {
  to: string;
  from: string;
  body: string;
  media?: string[];
  /**
   * Our message id, handed to the provider so its delivery callback can be
   * matched back without a lookup table. Providers that cannot carry it are
   * matched on their own id instead, which is why both are stored.
   */
  reference: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  /**
   * `retryable` is the whole reason this is not just an exception. A carrier
   * rate limit and a wrong phone number both fail, and treating them the same
   * means either giving up on a message that would have gone, or retrying a
   * number that will never work until somebody notices the queue.
   */
  | { ok: false; code: string; message: string; retryable: boolean };

/** What arrived, normalized. Providers disagree about nearly every field name. */
export interface InboundMessage {
  from: string;
  to: string;
  body: string;
  media: { url: string; contentType: string }[];
  providerMessageId: string;
}

/** A delivery receipt, which arrives minutes or hours after the send. */
export interface DeliveryReport {
  providerMessageId: string;
  /** Our id, when the provider carried it. */
  reference?: string | undefined;
  status: "sent" | "delivered" | "undelivered" | "failed";
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  /** The raw body, exactly as received. Re-serializing breaks every signature. */
  body: string;
}

export interface MessagingProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
  /**
   * Whether this request genuinely came from the provider.
   *
   * Not optional, and not a boolean flag somebody can turn off in settings.
   * An unverified inbound webhook endpoint lets anyone on the internet forge
   * a STOP from a customer, forge a message into a conversation an operator
   * will act on, or forge a delivery receipt saying a text arrived when it
   * did not.
   */
  verify(request: WebhookRequest): boolean;
  parseInbound(request: WebhookRequest): InboundMessage | null;
  parseDelivery(request: WebhookRequest): DeliveryReport | null;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No messaging provider configured for "${provider}"`);
    this.name = "ProviderNotConfiguredError";
  }
}

/**
 * Providers are registered rather than imported.
 *
 * A self hoster writing an adapter for their regional carrier should not have
 * to edit a switch statement in the middle of the send path, and a build that
 * imports every provider pulls every provider's dependencies into a
 * deployment that uses one.
 */
const registry = new Map<string, (settings: Record<string, unknown>, secret: string) => MessagingProvider>();

export function registerProvider(
  name: string,
  factory: (settings: Record<string, unknown>, secret: string) => MessagingProvider,
): void {
  registry.set(name, factory);
}

export function createProvider(
  name: string,
  settings: Record<string, unknown>,
  secret: string,
): MessagingProvider {
  const factory = registry.get(name);
  if (!factory) throw new ProviderNotConfiguredError(name);
  return factory(settings, secret);
}

export const registeredProviders = (): string[] => [...registry.keys()];
