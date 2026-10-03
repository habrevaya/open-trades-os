/**
 * GEOCODING: WHAT A COORDINATE CLAIMS, AND WHEN TO ASK AGAIN
 *
 * A geocoder answers an address with a point and, if it is honest, with how
 * sure it is. "4102 Ramsey Ave" placed on the house and "78756" placed in the
 * middle of a postcode are both a latitude and a longitude, and only one of
 * them is worth routing a van to. So a coordinate is never stored without its
 * PRECISION and its SOURCE, and a screen that draws a pin can say "roughly
 * here" when that is all it knows.
 *
 * A PIN SOMEBODY DROPPED BY HAND WINS. It is the office saying "the gate is
 * round the back, on the other street", which no geocoder will ever know, and
 * a nightly backfill that quietly moved it back to the front door would undo
 * the one piece of local knowledge the map holds. The geocoder never touches a
 * placed pin; clearing the pin is what hands the property back to it.
 */

/**
 * How close to the door a coordinate is, best first.
 *
 *   rooftop       on the building, or the parcel it stands on.
 *   interpolated  along the street, between two numbered addresses.
 *   street        somewhere on the right street.
 *   postal_code   the middle of the postcode.
 *   locality      the middle of the town.
 *   placed        dropped by a person, which outranks all of the above for
 *                 this purpose because they were looking at the gate.
 */
export const GEOCODE_PRECISIONS = [
  "rooftop", "interpolated", "street", "postal_code", "locality", "placed",
] as const;
export type GeocodePrecision = (typeof GEOCODE_PRECISIONS)[number];

/** The source written on a coordinate a person placed. A provider key otherwise. */
export const PLACED_BY_HAND = "manual";

/** Whether a pin is close enough to drive to, as opposed to a neighbourhood. */
export function isStreetLevel(precision: GeocodePrecision | null | undefined): boolean {
  return precision === "rooftop" || precision === "interpolated" || precision === "placed";
}

/** In words, for a pin's caption. */
export function describePrecision(precision: GeocodePrecision | null | undefined): string {
  switch (precision) {
    case "rooftop": return "On the building";
    case "interpolated": return "Along the street, between house numbers";
    case "street": return "Somewhere on the street";
    case "postal_code": return "The middle of the postcode only";
    case "locality": return "The middle of the town only";
    case "placed": return "Placed by hand";
    default: return "Not placed";
  }
}

export interface AddressParts {
  addressLine1: string | null;
  addressLine2?: string | null | undefined;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

/**
 * The one line a geocoder is asked, built the same way every time.
 *
 * The unit number is left out on purpose. "Suite 400" does not move the
 * building, and geocoders that do not understand it answer the whole line
 * with a postcode centroid rather than the street address in front of it.
 */
export function addressQuery(address: AddressParts): string {
  return [address.addressLine1, address.city, address.state, address.postalCode, address.country]
    .map((part) => (part ?? "").trim().replace(/\s+/g, " "))
    .filter((part) => part !== "")
    .join(", ");
}

/**
 * The address a coordinate answers for, normalised so that retyping it with
 * different spacing or capitals is not a change worth another lookup.
 *
 * The database computes the same key as a generated column, and
 * `addressKey` in a test is checked against it, because two definitions of
 * "the address changed" that disagree is a geocoder asked forever or never.
 */
export function addressKey(address: AddressParts): string {
  return [address.addressLine1, address.addressLine2, address.city, address.state, address.postalCode, address.country]
    .map((part) => (part ?? "").trim().replace(/\s+/g, " ").toLowerCase())
    .join("|");
}

export interface GeocodeState {
  /** The key of the address as it is now. */
  addressKey: string;
  /** The key the stored coordinate answers for, null when nothing is stored. */
  locatedAddress: string | null;
  /** Who placed the stored coordinate: `manual` or a provider key. */
  locationSource: string | null;
  /** The key the last ATTEMPT was for, successful or not. */
  attemptedAddress: string | null;
  /** When it may be asked again. Null after an attempt means never, for this address. */
  retryAt: Date | null;
  attempts: number;
}

/**
 * Whether this address should be sent to the geocoder now.
 *
 * Not when somebody placed it by hand, ever. Not when the stored coordinate
 * already answers for this exact address. Not when the geocoder has already
 * said it cannot find THIS address: asking again tomorrow gets the same
 * answer and costs a request against a free service that asks to be used
 * gently, so the next lookup waits for the address to change. A transient
 * failure is asked again after its back off.
 */
export function geocodeDue(state: GeocodeState, now: Date): boolean {
  if (state.locationSource === PLACED_BY_HAND) return false;
  if (state.locatedAddress === state.addressKey) return false;
  if (state.attemptedAddress !== state.addressKey) return true;
  return state.retryAt !== null && state.retryAt.getTime() <= now.getTime();
}

/**
 * How long to wait after a failure that might clear: a timeout, a 5xx, a
 * rate limit. Doubling from five minutes and capped at a day, so an outage
 * of the provider costs a handful of requests per address rather than one
 * per worker pass.
 */
export function retryAfter(attempts: number, now: Date): Date {
  const minutes = Math.min(24 * 60, 5 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + minutes * 60_000);
}

/** What an adapter hands back. Never throws for "not found": that is an answer. */
export type GeocodeOutcome =
  | { kind: "found"; lat: number; lng: number; precision: Exclude<GeocodePrecision, "placed">; label: string | null }
  | { kind: "not_found"; reason: string }
  | { kind: "failed"; reason: string; retryable: boolean };
