import { createHmac } from "node:crypto";
import type { financing } from "@opentradesos/core";
import type {
  ApplicationRequest, ApplicationState, FinancingEvent, FinancingProvider, WebhookRequest,
} from "../src/financing/provider";

/**
 * A LENDER THAT NEVER REACHES THE NETWORK
 *
 * Injected through the service's `deps`, as the payments tests inject a
 * processor, so a test asserts on the seam rather than on HTTP. It keeps what
 * it was asked to open, and what it will answer when an application is read
 * back is whatever the test last `set`, which is how a test plays the lender
 * approving, declining and funding.
 */
export const FAKE_SIGNATURE = "x-fake-lender-signature";

export interface FakeLender extends FinancingProvider {
  opened: ApplicationRequest[];
  set(externalId: string, state: Partial<ApplicationState>): void;
  /** A delivery for an application, signed as this fake checks signatures. */
  event(externalId: string, eventId: string, secret: string, status?: string): WebhookRequest;
  reads: number;
  failReads: boolean;
}

export function fakeLender(terms: financing.FinancingTerms = {
  lender: "Wisetack", minAmount: "500", maxAmount: "25000",
  plans: [{ months: 60, aprPercent: "17.9" }, { months: 12, aprPercent: "0" }],
}): FakeLender {
  const states = new Map<string, ApplicationState>();
  const fake: FakeLender = {
    name: "wisetack",
    opened: [],
    reads: 0,
    failReads: false,
    terms: () => terms,
    async createApplication(request) {
      fake.opened.push(request);
      const externalId = `fake_${request.reference}`;
      states.set(externalId, {
        externalId, status: "sent", rawStatus: "PENDING", approvedAmountMinor: null, chosenOffer: null,
        fundedAmountMinor: null, feeMinor: null, fundedAt: null, expiresAt: null,
      });
      return { ok: true, value: { externalId, applicationUrl: `https://lender.test/apply/${externalId}`, status: "sent", expiresAt: null } };
    },
    async readApplication(externalId) {
      fake.reads += 1;
      if (fake.failReads) return { ok: false, code: "network", message: "The lender is down.", retryable: true };
      const state = states.get(externalId);
      if (!state) return { ok: false, code: "http_404", message: "No such transaction", retryable: false };
      return { ok: true, value: state };
    },
    set(externalId, patch) {
      const current = states.get(externalId);
      if (!current) throw new Error(`The fake never opened ${externalId}`);
      states.set(externalId, { ...current, ...patch });
    },
    verify(request: WebhookRequest, secret: string) {
      const given = request.headers[FAKE_SIGNATURE];
      return given === createHmac("sha256", secret).update(request.body).digest("hex");
    },
    parseEvent(request: WebhookRequest): FinancingEvent | null {
      try {
        const json = JSON.parse(request.body) as { id?: string; application?: string; status?: string };
        if (!json.id || !json.application) return null;
        return {
          eventId: json.id, externalId: json.application, type: "status_changed",
          reportedStatus: (json.status ?? null) as financing.ApplicationStatus | null, reference: null,
        };
      } catch { return null; }
    },
    event(externalId, eventId, secret, status = "approved") {
      const body = JSON.stringify({ id: eventId, application: externalId, status });
      return { headers: { [FAKE_SIGNATURE]: createHmac("sha256", secret).update(body).digest("hex") }, body };
    },
  };
  return fake;
}
