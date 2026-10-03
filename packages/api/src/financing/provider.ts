import type { financing } from "@opentradesos/core";

/**
 * THE FINANCING SEAM
 *
 * The same shape as the payments seam next door and for the same reason: the
 * product knows about "this customer would like to borrow this much to pay
 * this invoice" and nothing about Wisetack, so a company whose lender is
 * somebody else writes an adapter rather than editing the invoice screen.
 *
 * THE LENDER IS THE CUSTOMER'S, NOT OURS. The customer applies on the
 * lender's own page and gives the lender what it asks for. What crosses this
 * seam is an amount, a reference, the customer's name and how to reach them
 * (so the lender can send them the link too), and coming back: a status, the
 * amount approved, the offer they chose, and when the loan is funded, what
 * was paid and what the lender kept. Nothing about the customer's credit
 * comes back, and nothing here asks for it.
 *
 * WHEN THE MONEY IS REAL is decided as it is for a card: a signed webhook,
 * verified, and then the application READ BACK from the lender before
 * anything is recorded. The webhook says something changed; the read says
 * what is true now. That second step is what makes a delivery that arrives
 * late, twice or out of order harmless, and it means a forged body that
 * somehow passed the signature still cannot invent a funding the lender's
 * own API does not report.
 */

/** Minor units, as every lender's API speaks them. */
export interface ApplicationRequest {
  /** Cents. An integer, never a float. */
  amountMinor: number;
  currency: string;
  /** Our application id, sent as the lender's idempotency key and carried back on every event. */
  reference: string;
  idempotencyKey: string;
  /** What the loan is for, as the customer will see it on the lender's page. */
  purpose: string;
  customer: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
  };
  /** Where the lender should send status changes, when it takes one per application. */
  callbackUrl: string | null;
}

export interface ApplicationCreated {
  externalId: string;
  /** The lender's page where the customer applies. */
  applicationUrl: string;
  status: financing.ApplicationStatus;
  expiresAt: Date | null;
}

/** Everything the lender says about an application right now, normalised. */
export interface ApplicationState {
  externalId: string;
  status: financing.ApplicationStatus;
  /** The lender's own word for it, kept for the log and for triage. */
  rawStatus: string;
  approvedAmountMinor: number | null;
  chosenOffer: { months: number; aprPercent: string; monthlyPaymentMinor: number | null } | null;
  /** What the lender paid out on funding, before its fee. */
  fundedAmountMinor: number | null;
  /**
   * What the lender kept. Null when it has not said, which is NOT zero: a
   * fee booked as zero overstates the bank by the fee on every loan.
   */
  feeMinor: number | null;
  fundedAt: Date | null;
  expiresAt: Date | null;
}

export type FinancingOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface WebhookRequest {
  headers: Record<string, string>;
  /** The raw body, exactly as received. Re-serialising breaks every signature. */
  body: string;
}

/**
 * What a delivery says, before it is believed.
 *
 * `eventId` is what deduplicates: lenders retry for days and the same event
 * arrives again. `externalId` is which application, and the status is a hint
 * only, because the application is read back before anything is acted on.
 */
export interface FinancingEvent {
  eventId: string;
  externalId: string;
  type: string;
  reportedStatus: financing.ApplicationStatus | null;
  /** Our own reference, when the lender carries it back. */
  reference: string | null;
}

export interface FinancingProvider {
  readonly name: string;
  /** The plans and limits "as low as" is worked out from. */
  terms(): financing.FinancingTerms;
  createApplication(request: ApplicationRequest): Promise<FinancingOutcome<ApplicationCreated>>;
  readApplication(externalId: string): Promise<FinancingOutcome<ApplicationState>>;
  /**
   * Whether a delivery genuinely came from the lender. Not optional, for the
   * reason the payments seam gives: an unverified webhook is an endpoint
   * where anybody can say a loan was funded.
   */
  verify(request: WebhookRequest, secret: string): boolean;
  parseEvent(request: WebhookRequest): FinancingEvent | null;
}

export class FinancingNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No financing provider configured for "${provider}"`);
    this.name = "FinancingNotConfiguredError";
  }
}

const registry = new Map<string, (settings: Record<string, unknown>, secret: string) => FinancingProvider>();

export function registerFinancingProvider(
  name: string,
  factory: (settings: Record<string, unknown>, secret: string) => FinancingProvider,
): void {
  registry.set(name, factory);
}

export function createFinancingProvider(
  name: string, settings: Record<string, unknown>, secret: string,
): FinancingProvider {
  const factory = registry.get(name);
  if (!factory) throw new FinancingNotConfiguredError(name);
  return factory(settings, secret);
}

export const registeredFinancingProviders = (): string[] => [...registry.keys()];
