import {
  amountOf, basicPasswordMatches, momentOf, objectBody, questionsAsNotes, registerMarketplace, str, textSetting,
  PlatformRefusedError, PlatformUnavailableError, AuthorizationLostError,
  type MarketplaceAdapter, type MarketplaceEvent, type MarketplaceInput,
} from "./provider";

/**
 * THUMBTACK
 *
 * Thumbtack posts each new lead, and each message a customer writes on one,
 * to the address the partner registered, with HTTP Basic credentials the
 * partner chose; replies go back through its API against the lead. Built to
 * Thumbtack's partner API documentation and tested against a fake of it: the
 * approval Thumbtack requires before any of this answers is the operator's to
 * obtain, and the first real lead is where a difference would show.
 *
 * A lead carries what Thumbtack charged for it as `price`, which becomes the
 * offer's charge and a spend row, so the channel's cost per lead is Thumbtack's
 * real one rather than one somebody typed.
 */

const DEFAULT_BASE = "https://api.thumbtack.com";

function createThumbtack(input: MarketplaceInput): MarketplaceAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const businessId = textSetting(input.settings, "businessId");

  /** The business a post is about, wherever this payload puts it. */
  const businessOf = (body: Record<string, unknown>) =>
    str(body["businessID"]) ?? str((body["business"] as Record<string, unknown> | undefined)?.["businessID"]);

  return {
    platform: "thumbtack",

    verify(request) {
      if (!basicPasswordMatches(request.headers, input.webhookSecret)) return false;
      /** A post about another business is not this company's, whoever signed it. */
      const body = objectBody(request.body);
      const about = body ? businessOf(body) : null;
      return !(businessId && about && about !== businessId);
    },

    parse(request) {
      const body = objectBody(request.body);
      if (!body) return null;
      const leadId = str(body["leadID"]);
      if (!leadId) return null;
      const message = body["message"] as Record<string, unknown> | undefined;
      if (message && typeof message === "object") {
        const id = str(message["messageID"]);
        const text = str(message["text"]);
        if (!id || !text) return null;
        const event: MarketplaceEvent = {
          kind: "message",
          message: {
            leadExternalId: leadId, externalId: id, body: text.slice(0, 4000),
            at: momentOf(message["createTimestamp"]),
            from: str(message["senderType"])?.toLowerCase() === "business" ? "business" : "customer",
          },
        };
        return [event];
      }
      const customer = (body["customer"] ?? {}) as Record<string, unknown>;
      const req = (body["request"] ?? {}) as Record<string, unknown>;
      const location = (req["location"] ?? {}) as Record<string, unknown>;
      const name = str(customer["name"]);
      const phone = str(customer["phone"]);
      const email = str(customer["email"]);
      const notes = [str(req["description"]), questionsAsNotes(req["details"], "question", "answer"), str(req["schedule"])]
        .filter(Boolean).join("\n") || null;
      return [{
        kind: "lead",
        lead: {
          externalId: leadId,
          contactName: name ?? "Thumbtack customer",
          contactPhone: phone,
          contactEmail: email,
          addressLine1: str(location["address1"]),
          city: str(location["city"]),
          state: str(location["state"]),
          postalCode: str(location["zipCode"]),
          serviceRequested: str(req["category"]) ?? str(req["title"]),
          notes: notes ? notes.slice(0, 4000) : null,
          estimatedValue: null,
          expiresAt: null,
          source: "marketplace",
          raw: body,
          charge: amountOf(body["price"]),
        },
      }];
    },

    async sendMessage(leadExternalId, text) {
      if (!businessId) throw new PlatformRefusedError("Enter the Thumbtack business id for this lead source.");
      if (!input.apiToken) throw new PlatformRefusedError("The Thumbtack access token is not in the secret store under the name given.");
      let response;
      try {
        response = await input.transport(
          `${base}/v2/business/${encodeURIComponent(businessId)}/lead/${encodeURIComponent(leadExternalId)}/message`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${input.apiToken}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ text }),
          },
        );
      } catch (error) {
        throw new PlatformUnavailableError(`Thumbtack could not be reached: ${(error as Error).message}`);
      }
      const raw = await response.text();
      const parsed = objectBody(raw) ?? {};
      if (response.status === 401 || response.status === 403) {
        throw new AuthorizationLostError("Thumbtack no longer accepts the access token. Put a current one in the secret store.");
      }
      if (response.status === 429 || response.status >= 500) {
        throw new PlatformUnavailableError(`Thumbtack answered HTTP ${response.status}. Try again in a minute.`);
      }
      if (response.status < 200 || response.status >= 300) {
        const words = str((parsed["error"] as Record<string, unknown> | undefined)?.["message"]) ?? str(parsed["message"]) ?? "";
        throw new PlatformRefusedError(`Thumbtack refused the reply (HTTP ${response.status})${words ? `: ${words.slice(0, 300)}` : ""}`);
      }
      return { externalId: str(parsed["messageID"]) };
    },
  };
}

registerMarketplace("thumbtack", createThumbtack);
