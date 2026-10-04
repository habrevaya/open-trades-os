import {
  PlatformRefusedError, PlatformUnavailableError, failure, registerAdsAdapter, textSetting,
  type AdapterInput, type AdsAdapter, type EventOutcome, type OutboundEvent,
} from "./provider";

/**
 * GOOGLE ANALYTICS 4, THROUGH THE MEASUREMENT PROTOCOL
 *
 * A `generate_lead` when a job is booked and a `purchase` when it is paid,
 * each tied to the visitor's client id from the `_ga` cookie the website
 * snippet read, so the booked job lands on the visit in the company's own
 * analytics instead of the visit ending at the contact page.
 *
 * NO SIGN IN. The Measurement Protocol is authenticated by an API secret the
 * operator creates in the property's data stream settings, kept in their
 * secret store and named here like every other key. It travels in the URL,
 * because that is the only place Google accepts it, which is why it should be
 * a secret used for nothing else.
 *
 * WHAT A 2XX MEANS HERE, said plainly: that Google received the request.
 * The Measurement Protocol answers 204 to a malformed event as readily as to
 * a good one and drops the bad one without a word, so "sent" on a GA4 row is
 * weaker than "sent" on a Google Ads row, and the docs say so. Nothing that
 * identifies a person is ever sent, hashed or not, because Google's terms for
 * Analytics forbid it.
 */

const DEFAULT_BASE = "https://www.google-analytics.com";
/** Google takes an event's own time only within the last seventy two hours. */
const BACKDATE_LIMIT_MS = 71 * 3_600_000;

function createGa4(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const measurementId = textSetting(input.settings, "measurementId");
  const apiSecret = input.secrets["apiSecret"];

  return {
    provider: "ga4",
    async sendEvents(events: OutboundEvent[]): Promise<EventOutcome[]> {
      if (!measurementId || !/^G-[A-Z0-9]+$/i.test(measurementId)) {
        throw new PlatformRefusedError("Enter the measurement id of the website's data stream, which starts G-.");
      }
      if (!apiSecret) throw new PlatformRefusedError("The Measurement Protocol API secret is not in the secret store under the name given.");
      const url = `${base}/mp/collect?${new URLSearchParams({ measurement_id: measurementId, api_secret: apiSecret }).toString()}`;
      const outcomes: EventOutcome[] = [];
      for (const event of events) {
        if (!event.clientId) {
          outcomes.push({ eventId: event.eventId, ok: false, message: "No analytics client id." });
          continue;
        }
        const recent = Date.now() - event.at.getTime() < BACKDATE_LIMIT_MS;
        const body = {
          client_id: event.clientId,
          ...(recent ? { timestamp_micros: event.at.getTime() * 1000 } : {}),
          consent: { ad_user_data: event.adUserData, ad_personalization: "DENIED" },
          events: [{
            name: event.kind === "purchase" ? "purchase" : "generate_lead",
            params: {
              ...(event.value !== null ? { value: Number(event.value), currency: event.currency } : {}),
              /** GA reports one purchase per transaction id, which is what makes a repeated send harmless. */
              ...(event.kind === "purchase" ? { transaction_id: event.eventId } : { lead_id: event.eventId }),
            },
          }],
        };
        let response;
        try {
          response = await input.transport(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (error) {
          throw new PlatformUnavailableError(`Google Analytics could not be reached: ${(error as Error).message}`);
        }
        if (response.status >= 200 && response.status < 300) {
          outcomes.push({ eventId: event.eventId, ok: true });
          continue;
        }
        const error = failure(response.status, "Google Analytics", (await response.text()).slice(0, 200));
        if (error instanceof PlatformRefusedError) outcomes.push({ eventId: event.eventId, ok: false, message: error.message });
        else throw error;
      }
      return outcomes;
    },
  };
}

registerAdsAdapter("ga4", createGa4);
