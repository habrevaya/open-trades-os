import { describe, it, expect } from "vitest";
import { webhooks } from "@opentradesos/api/services";
import { verifyWebhook, WebhookVerificationError } from "../src/webhooks";

/**
 * The receiver's half, checked against the server's own signing code rather
 * than a copy of it, so the two cannot quietly disagree about the order of
 * the timestamp and the body.
 */
const body = JSON.stringify({ id: "e1", name: "job.completed", sequence: 3, occurredAt: "2026-01-01T00:00:00Z", organizationId: "o", entity: { type: "job", id: "j" }, payload: {} });
const now = 1_767_225_600_000;

describe("verifying a delivery", () => {
  it("accepts a delivery signed with the secret, and returns the event", async () => {
    const { signature, timestamp } = webhooks.signDelivery({ secret: "whsec_a", body, timestamp: now });
    const event = await verifyWebhook({
      secret: "whsec_a", body, now,
      headers: { "x-otos-signature": signature, "x-otos-timestamp": timestamp },
    });
    expect(event.name).toBe("job.completed");
  });

  it("accepts either secret during a rotation's overlap, from either side", async () => {
    const { signature, timestamp } = webhooks.signatureHeader({ secrets: ["whsec_new", "whsec_old"], body, timestamp: now });
    const headers = new Headers({ "x-otos-signature": signature, "x-otos-timestamp": timestamp });
    await expect(verifyWebhook({ secret: "whsec_old", body, headers, now })).resolves.toBeDefined();
    await expect(verifyWebhook({ secret: "whsec_new", body, headers, now })).resolves.toBeDefined();
    await expect(verifyWebhook({ secret: ["whsec_other", "whsec_new"], body, headers, now })).resolves.toBeDefined();
  });

  it("refuses the wrong secret, a changed body, an old delivery and missing headers", async () => {
    const { signature, timestamp } = webhooks.signDelivery({ secret: "whsec_a", body, timestamp: now });
    const headers = { "x-otos-signature": signature, "x-otos-timestamp": timestamp };
    await expect(verifyWebhook({ secret: "whsec_b", body, headers, now })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhook({ secret: "whsec_a", body: `${body} `, headers, now })).rejects.toThrow(/No signature matches/);
    await expect(verifyWebhook({ secret: "whsec_a", body, headers, now: now + 10 * 60 * 1000 })).rejects.toThrow(/replay/);
    await expect(verifyWebhook({ secret: "whsec_a", body, headers: {}, now })).rejects.toThrow(/required/);
  });
});
