import type { CalendarDocument, CalendarEvent } from "./ics";

/**
 * THE CALENDAR SEAM
 *
 * `calendar` has been a member of the capability enum since the first
 * migration with no provider behind it. This is the first one.
 *
 * The seam is drawn at "render a set of visits into something a calendar
 * client will accept", because that is the part that differs between the
 * ways of doing this. A published ICS feed and a CalDAV collection hold the
 * same events and disagree about transport, authentication and whether the
 * client may write back. Drawing the seam at the document means the service
 * that decides WHICH visits a feed may show, and what of a customer's
 * details appears on them, is written once and is not a provider's business.
 *
 * The shape is deliberately read-only. Two-way CalDAV is a second adapter
 * with a wider interface, not a boolean on this one: a provider that can
 * accept a change from a phone needs conflict handling, and pretending the
 * two are the same interface is how the read-only one ends up silently
 * dropping an edit somebody made on a train.
 */
export interface CalendarProvider {
  readonly name: string;
  /**
   * Whether a subscriber can change anything. False for every provider
   * today, and stated as a value rather than left implicit so a settings
   * screen can say so without knowing which provider is configured.
   */
  readonly writable: boolean;
  render(document: CalendarDocument): string;
  /** The media type the feed is served as. A client sniffing HTML will not subscribe. */
  readonly contentType: string;
}

export type { CalendarDocument, CalendarEvent };

export class CalendarProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No calendar provider configured for "${provider}"`);
    this.name = "CalendarProviderNotConfiguredError";
  }
}

/**
 * Registered rather than imported, exactly as the messaging and payment
 * seams are. A deployment that wants a different flavour of feed drops the
 * barrel and registers its own; nothing in the feed path names this one.
 */
const registry = new Map<string, () => CalendarProvider>();

export function registerCalendarProvider(name: string, factory: () => CalendarProvider): void {
  registry.set(name, factory);
}

export function createCalendarProvider(name: string): CalendarProvider {
  const factory = registry.get(name);
  if (!factory) throw new CalendarProviderNotConfiguredError(name);
  return factory();
}

export const registeredCalendarProviders = (): string[] => [...registry.keys()];
