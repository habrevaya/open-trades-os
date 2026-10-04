import type { HttpTransport } from "../accounting/provider";

export type { HttpTransport };
export { PlatformRefusedError, PlatformUnavailableError } from "../ads/provider";

/**
 * THE MAIL HOUSE SEAM
 *
 * One method: print this piece and post it. Everything about who gets one,
 * what it says, what it cost and what came of it is the service's. The
 * adapter is handed one finished piece (the HTML already filled in and
 * escaped) and returns the printer's id for it.
 *
 * `idempotencyKey` is the piece's own id, and every adapter must pass it to
 * the printer as the printer's idempotency key: a send retried after a
 * timeout must not print a second card, and the only party that can promise
 * that is the printer.
 */

export interface MailParty {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
}

export interface MailRequest {
  idempotencyKey: string;
  kind: "postcard" | "letter";
  size: string | null;
  to: MailParty;
  from: MailParty;
  /** Finished HTML for the front (or the letter) and the back. */
  front: string;
  back: string | null;
  /** Where the piece's QR code sends a phone: its personal address. */
  qrUrl: string;
  description: string;
}

export interface MailResult {
  providerId: string;
  /** ISO date the printer expects it to arrive, when it says. */
  expectedDeliveryOn: string | null;
}

export interface MailProvider {
  readonly name: string;
  send(request: MailRequest): Promise<MailResult>;
}

export interface MailProviderInput {
  settings: Record<string, unknown>;
  apiKey: string;
  transport: HttpTransport;
}

const registry = new Map<string, (input: MailProviderInput) => MailProvider>();

export function registerMailProvider(name: string, factory: (input: MailProviderInput) => MailProvider): void {
  registry.set(name, factory);
}

export function createMailProvider(name: string, input: MailProviderInput): MailProvider {
  const factory = registry.get(name);
  if (!factory) throw new Error(`No mail provider registered for "${name}"`);
  return factory(input);
}

/** Read by the catalogue test. */
export const registeredMailProviders = (): string[] => [...registry.keys()];
