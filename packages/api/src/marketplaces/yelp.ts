import {
  momentOf, objectBody, questionsAsNotes, registerMarketplace, str, textSetting,
  AuthorizationLostError, PlatformRefusedError, PlatformUnavailableError,
  type Fetched, type MarketplaceAdapter, type MarketplaceInput, type MarketplaceMessage,
} from "./provider";

/**
 * YELP REQUEST A QUOTE (THE LEADS API)
 *
 * Yelp posts only that something happened on a lead: a business id and a
 * list of lead ids. Nothing a person said is in the post, and nothing in it
 * is believed. The lead and its messages are read from Yelp with the
 * company's token, so a forged post can at most make this ask Yelp about a
 * lead Yelp then says is not this business's. That is the verification, and
 * it is why a post about another business id is refused before anything is
 * asked.
 *
 * The customer's phone number is usually withheld; Yelp's relay address is
 * the way to reach them, and replies written here go back as Yelp messages.
 * Built to Yelp's Leads API documentation and tested against a fake of it;
 * Yelp opens the API only to partners it approves.
 */

const DEFAULT_BASE = "https://api.yelp.com";

function createYelp(input: MarketplaceInput): MarketplaceAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const businessId = textSetting(input.settings, "businessId");

  async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!input.apiToken) throw new PlatformRefusedError("The Yelp access token is not in the secret store under the name given.");
    let response;
    try {
      response = await input.transport(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${input.apiToken}`, Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new PlatformUnavailableError(`Yelp could not be reached: ${(error as Error).message}`);
    }
    const parsed = objectBody(await response.text()) ?? {};
    if (response.status === 401 || response.status === 403) {
      throw new AuthorizationLostError("Yelp no longer accepts the access token for this business. Put a current one in the secret store.");
    }
    if (response.status === 429 || response.status >= 500) throw new PlatformUnavailableError(`Yelp answered HTTP ${response.status}. It will be asked again.`);
    if (response.status < 200 || response.status >= 300) {
      const error = (parsed["error"] ?? {}) as Record<string, unknown>;
      throw new PlatformRefusedError(`Yelp refused the request (HTTP ${response.status}): ${(str(error["description"]) ?? str(error["code"]) ?? "").slice(0, 300)}`);
    }
    return parsed;
  }

  return {
    platform: "yelp",

    verify(request) {
      const body = objectBody(request.body);
      const data = (body?.["data"] ?? {}) as Record<string, unknown>;
      return Boolean(businessId) && str(data["id"]) === businessId;
    },

    parse(request) {
      const body = objectBody(request.body);
      const data = (body?.["data"] ?? null) as Record<string, unknown> | null;
      if (!data || !Array.isArray(data["updates"])) return null;
      const ids = new Set<string>();
      for (const update of data["updates"] as Record<string, unknown>[]) {
        const lead = str(update["lead_id"]);
        if (lead) ids.add(lead);
      }
      return [...ids].map((leadExternalId) => ({ kind: "notice" as const, leadExternalId }));
    },

    async fetchLead(leadExternalId) {
      const id = encodeURIComponent(leadExternalId);
      const lead = await call("GET", `/v3/leads/${id}`);
      if (businessId && str(lead["business_id"]) && str(lead["business_id"]) !== businessId) return null;
      const user = (lead["user"] ?? {}) as Record<string, unknown>;
      const project = (lead["project"] ?? {}) as Record<string, unknown>;
      const location = (project["location"] ?? {}) as Record<string, unknown>;
      const jobs = Array.isArray(project["job_names"]) ? (project["job_names"] as unknown[]).map(str).filter(Boolean) : [];
      const notes = [questionsAsNotes(project["survey_answers"], "question_text", "answer_text"), str(project["additional_info"])]
        .filter(Boolean).join("\n") || null;
      const events = await call("GET", `/v3/leads/${id}/events?limit=50`);
      const messages: MarketplaceMessage[] = [];
      for (const event of Array.isArray(events["events"]) ? events["events"] as Record<string, unknown>[] : []) {
        const content = (event["event_content"] ?? {}) as Record<string, unknown>;
        const text = str(content["text"]) ?? str(content["fallback_text"]);
        const eventId = str(event["id"]);
        if (!text || !eventId || str(event["event_type"]) !== "TEXT") continue;
        messages.push({
          leadExternalId, externalId: eventId, body: text.slice(0, 4000), at: momentOf(event["time_created"]),
          from: str(event["user_type"]) === "BIZ" ? "business" : "customer",
        });
      }
      const fetched: Fetched = {
        lead: {
          externalId: leadExternalId,
          contactName: str(user["display_name"]) ?? "Yelp customer",
          contactPhone: null,
          contactEmail: str(lead["temporary_email_address"]),
          addressLine1: null,
          city: null,
          state: null,
          postalCode: str(location["postal_code"]),
          serviceRequested: jobs.join(", ") || null,
          notes: notes ? notes.slice(0, 4000) : null,
          estimatedValue: null,
          expiresAt: null,
          source: "marketplace",
          raw: lead,
          charge: null,
        },
        messages: messages.sort((a, b) => a.at.getTime() - b.at.getTime()),
      };
      return fetched;
    },

    async sendMessage(leadExternalId, text) {
      const answer = await call("POST", `/v3/leads/${encodeURIComponent(leadExternalId)}/events`, {
        request_content: text, request_type: "TEXT",
      });
      return { externalId: str(answer["id"]) ?? str(answer["event_id"]) };
    },
  };
}

registerMarketplace("yelp", createYelp);
