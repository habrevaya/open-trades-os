import {
  amountOf, basicPasswordMatches, objectBody, questionsAsNotes, registerMarketplace, str,
  type MarketplaceAdapter, type MarketplaceInput,
} from "./provider";

/**
 * ANGI LEADS (AND HOMEADVISOR)
 *
 * Angi posts each lead it sells to the address a CRM partner registered, as
 * JSON, with HTTP Basic credentials the partner chose. There is no message
 * thread to take part in and no API to write back with: a lead from Angi is
 * answered by ringing the customer, which is what the offer's number is for.
 *
 * Built to the shape Angi's lead delivery documents and tested against a fake
 * of it. Angi delivers to a CRM only for a partner it has approved, which is
 * the operator's to obtain; until then the same leads arrive by email.
 *
 * `fee` is what Angi charged for the lead, which becomes its charge and a
 * spend row; a lead Angi later credits back is not taken out by itself.
 */

function createAngi(input: MarketplaceInput): MarketplaceAdapter {
  return {
    platform: "angi",

    verify(request) {
      return basicPasswordMatches(request.headers, input.webhookSecret);
    },

    parse(request) {
      const body = objectBody(request.body);
      if (!body) return null;
      const leadId = str(body["leadOid"]) ?? str(body["leadId"]) ?? str(body["srOid"]);
      if (!leadId) return null;
      const name = str(body["name"]) ?? ([str(body["firstName"]), str(body["lastName"])].filter(Boolean).join(" ") || null);
      const notes = [str(body["comments"]), str(body["leadDescription"]), questionsAsNotes(body["interview"], "question", "answer")]
        .filter(Boolean).join("\n") || null;
      return [{
        kind: "lead",
        lead: {
          externalId: leadId,
          contactName: name ?? "Angi customer",
          contactPhone: str(body["primaryPhone"]) ?? str(body["phone"]) ?? str(body["secondaryPhone"]),
          contactEmail: str(body["email"]),
          addressLine1: str(body["address"]),
          city: str(body["city"]),
          state: str(body["stateProvince"]) ?? str(body["state"]),
          postalCode: str(body["postalCode"]) ?? str(body["zip"]),
          serviceRequested: str(body["taskName"]) ?? str(body["categoryName"]),
          notes: notes ? notes.slice(0, 4000) : null,
          estimatedValue: null,
          expiresAt: null,
          source: "marketplace",
          raw: body,
          charge: amountOf(body["fee"]) ?? amountOf(body["leadFee"]),
        },
      }];
    },
  };
}

registerMarketplace("angi", createAngi);
