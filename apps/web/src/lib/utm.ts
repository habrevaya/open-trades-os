/**
 * The utm tags out of the landing query, for the `utm` field.
 *
 * The raw query goes as well and is what the touch is parsed from; this is
 * kept for whatever reads the request's own `utm` column, which a widget
 * sending an empty bag left blank on every booking.
 */
export function utmOf(query: string | undefined): Record<string, string> {
  // A Map, so no key from the query is ever written onto an object. Only the
  // `utm_` ones are kept, and fromEntries defines own properties rather than
  // assigning, so there is no prototype to reach either way.
  const utm = new Map<string, string>();
  if (!query) return {};
  try {
    for (const [key, value] of new URLSearchParams(query)) {
      if (key.startsWith("utm_") && value && !utm.has(key)) utm.set(key, value.slice(0, 200));
    }
  } catch {
    // A query that will not parse still goes through as `landingQuery`.
  }
  return Object.fromEntries(utm);
}
