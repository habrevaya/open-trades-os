/**
 * THE MARKETING PROVIDER SEAM
 *
 * Two interfaces, matching the two directions marketing data actually moves.
 *
 *   A SPEND SOURCE says what a channel cost. It is handed bytes or a
 *   response and returns daily rows; it never touches the database, so the
 *   idempotency, the source catalogue check and the manual-versus-imported
 *   rule all stay in one place in the service.
 *
 *   A LEAD SOURCE says somebody arrived. It verifies that the request really
 *   came from who it claims, and normalises whatever shape they send into
 *   the one the product takes.
 *
 * WHY VERIFICATION IS NOT OPTIONAL, AND NOT A SETTING
 *
 * `verify` is required on a lead source for the same reason it is required
 * on a messaging provider. An unverified lead endpoint lets anybody on the
 * internet inject a job into a contractor's dispatch board, book capacity
 * that does not exist, and drive a van to an address that did not ask for
 * one. The signature is what makes the URL safe to give out, and a product
 * that let an operator turn it off would be handing them that choice
 * without the context to make it.
 *
 * The adapters are registered rather than imported, so a deployment that
 * writes its own for a regional marketplace does not edit a switch in the
 * middle of the intake path.
 */

export interface SpendDay {
  /** A key from core's lead source catalogue. The adapter maps into it. */
  source: string;
  campaign: string | null;
  /** ISO date, in the ACCOUNT's timezone as the platform reported it. */
  spentOn: string;
  amount: string;
  impressions: number | null;
  clicks: number | null;
  /** The platform's own row id, when it has one. Makes a re-import an update. */
  externalId: string | null;
}

export type SpendParse =
  | { ok: true; rows: SpendDay[]; skipped: { line: number; reason: string }[] }
  | { ok: false; reason: string };

export interface SpendSource {
  readonly name: string;
  /**
   * Turn an export into daily rows.
   *
   * Returns SKIPPED lines rather than throwing on the first bad one. A
   * contractor's export has a totals row at the bottom, a currency symbol in
   * one column and a campaign that was renamed halfway through the month,
   * and an importer that refuses the file over any of those is an importer
   * they stop using in February.
   */
  parse(input: { text: string; settings: Record<string, unknown> }): SpendParse;
}

/** What a lead source hands over, once it is normalised. */
export interface InboundLead {
  /** The marketplace's own id for this lead. Makes acceptance idempotent. */
  externalId: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  serviceRequested: string | null;
  notes: string | null;
  /** What the lead is thought to be worth, when the source says. */
  estimatedValue: string | null;
  /** Offers expire fast, and speed to lead is the whole game. */
  expiresAt: Date | null;
  /** A key from core's lead source catalogue. */
  source: string;
  /** Kept whole, because a field mapping is always wrong about something. */
  raw: Record<string, unknown>;
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  /** The raw body, exactly as received. Re-serializing breaks every signature. */
  body: string;
}

export interface LeadSource {
  readonly name: string;
  /**
   * Whether this request genuinely came from the source.
   *
   * Not optional, and not a flag somebody can turn off. See the note at the
   * top of this file: the answer to "can we skip this for now" is that the
   * endpoint is a job creation API on the open internet until this returns
   * false for a forged request.
   */
  verify(request: WebhookRequest, secret: string): boolean;
  parse(request: WebhookRequest): InboundLead | null;
}

export class SourceNotConfiguredError extends Error {
  constructor(name: string) {
    super(`No marketing adapter registered for "${name}"`);
    this.name = "SourceNotConfiguredError";
  }
}

const spendRegistry = new Map<string, () => SpendSource>();
const leadRegistry = new Map<string, () => LeadSource>();

export function registerSpendSource(name: string, factory: () => SpendSource): void {
  spendRegistry.set(name, factory);
}

export function registerLeadSource(name: string, factory: () => LeadSource): void {
  leadRegistry.set(name, factory);
}

export function createSpendSource(name: string): SpendSource {
  const factory = spendRegistry.get(name);
  if (!factory) throw new SourceNotConfiguredError(name);
  return factory();
}

export function createLeadSource(name: string): LeadSource {
  const factory = leadRegistry.get(name);
  if (!factory) throw new SourceNotConfiguredError(name);
  return factory();
}

/**
 * Every adapter that is actually registered.
 *
 * Read by the catalogue test, which asserts that nothing in core's connector
 * list claims to be `built` without appearing here. That test is the only
 * thing stopping the catalogue drifting into a list of intentions with
 * checkboxes beside them.
 */
export const registeredSpendSources = (): string[] => [...spendRegistry.keys()];
export const registeredLeadSources = (): string[] => [...leadRegistry.keys()];
