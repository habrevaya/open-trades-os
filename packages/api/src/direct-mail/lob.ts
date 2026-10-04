import {
  registerMailProvider, PlatformRefusedError, PlatformUnavailableError,
  type MailParty, type MailProvider, type MailProviderInput,
} from "./provider";

/**
 * LOB
 *
 * Postcards (`/v1/postcards`) and letters (`/v1/letters`), each posted with
 * the piece's id as Lob's `Idempotency-Key`, the API key as the Basic user
 * name with no password, `use_type: marketing` (which Lob requires on every
 * piece and which decides the postal rules), and a QR code Lob prints onto
 * the piece pointing at its personal address.
 *
 * A key that starts `test_` prints and posts nothing and charges nothing,
 * which is how a company looks at a mailing before it is real. Built to Lob's
 * documented API and tested against a fake of it.
 */

const DEFAULT_BASE = "https://api.lob.com";

const party = (p: MailParty) => ({
  name: p.name.slice(0, 40),
  address_line1: p.line1,
  ...(p.line2 ? { address_line2: p.line2 } : {}),
  address_city: p.city,
  address_state: p.state.toUpperCase(),
  address_zip: p.postalCode,
  address_country: "US",
});

function createLob(input: MailProviderInput): MailProvider {
  const base = (typeof input.settings["baseUrl"] === "string" && input.settings["baseUrl"].trim() !== ""
    ? input.settings["baseUrl"] : DEFAULT_BASE).replace(/\/$/, "");

  return {
    name: "lob",
    async send(request) {
      const path = request.kind === "letter" ? "/v1/letters" : "/v1/postcards";
      const body = {
        description: request.description.slice(0, 255),
        to: party(request.to),
        from: party(request.from),
        use_type: "marketing",
        metadata: { piece: request.idempotencyKey },
        qr_code: {
          position: "relative",
          redirect_url: request.qrUrl,
          width: "1",
          bottom: "0.25",
          left: "0.25",
          pages: request.kind === "letter" ? "1" : "back",
        },
        ...(request.kind === "letter"
          ? { file: request.front, color: false }
          : { front: request.front, back: request.back ?? "", size: request.size ?? "4x6" }),
      };
      let response;
      try {
        response = await input.transport(`${base}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${input.apiKey}:`).toString("base64")}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": request.idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new PlatformUnavailableError(`Lob could not be reached: ${(error as Error).message}`);
      }
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* the status says enough */ }
      if (response.status === 429 || response.status >= 500) {
        throw new PlatformUnavailableError(`Lob answered HTTP ${response.status}. It will be tried again.`);
      }
      if (response.status < 200 || response.status >= 300) {
        const error = (parsed["error"] ?? {}) as { message?: unknown };
        const words = typeof error.message === "string" ? error.message.slice(0, 300) : "";
        throw new PlatformRefusedError(`Lob refused the piece (HTTP ${response.status})${words ? `: ${words}` : ""}`);
      }
      if (typeof parsed["id"] !== "string") throw new PlatformUnavailableError("Lob took the piece and gave no id for it.");
      const expected = parsed["expected_delivery_date"];
      return {
        providerId: parsed["id"],
        expectedDeliveryOn: typeof expected === "string" && /^\d{4}-\d{2}-\d{2}/.test(expected) ? expected.slice(0, 10) : null,
      };
    },
  };
}

registerMailProvider("lob", createLob);
