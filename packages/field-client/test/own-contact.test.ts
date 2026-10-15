import { describe, it, expect } from "vitest";
import {
  FieldApi, ApiError, OfflineError, SignedOutError, contactBody, contactChanged, contactFormOf, addressLine,
  phoneWords, EMPTY_CONTACT_FORM, type OwnContactRecord,
} from "../src/index";

/**
 * A PERSON'S OWN PHONE AND ADDRESS, FROM THE PHONE
 *
 * The same route `/me` saves through. What the phone owns is the shape of the
 * request (every box sent, an empty one as null so it takes that part off) and
 * what it does with the answer: the server's own sentence for a refusal, an
 * honest "no signal" for no answer, and nothing queued.
 */

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const kept: OwnContactRecord = {
  contact: {
    phone: "+15125550143", addressLine1: "12 Elm St", addressLine2: null, city: "Austin", state: "TX",
    postalCode: "78704", savedAt: "2026-10-01T15:00:00.000Z",
  },
  changes: [],
};

describe("the boxes", () => {
  it("are filled from what the server keeps, the phone as a person dials it", () => {
    expect(contactFormOf(kept)).toEqual({
      phone: "(512) 555-0143", addressLine1: "12 Elm St", addressLine2: "", city: "Austin", state: "TX", postalCode: "78704",
    });
    expect(contactFormOf({ contact: null, changes: [] })).toEqual(EMPTY_CONTACT_FORM);
    expect(contactFormOf(null)).toEqual(EMPTY_CONTACT_FORM);
  });

  it("send every box, an empty one as null so the server takes that part off", () => {
    expect(contactBody({ ...EMPTY_CONTACT_FORM, phone: "  (512)   555-0199 ", addressLine1: "   " })).toEqual({
      phone: "(512) 555-0199", addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null,
    });
  });

  it("notice when nothing was changed, whatever the spacing", () => {
    expect(contactChanged(contactFormOf(kept), kept)).toBe(false);
    expect(contactChanged({ ...contactFormOf(kept), city: " Austin " }, kept)).toBe(false);
    expect(contactChanged({ ...contactFormOf(kept), city: "Round Rock" }, kept)).toBe(true);
    expect(contactChanged({ ...contactFormOf(kept), phone: "" }, kept)).toBe(true);
    expect(contactChanged(EMPTY_CONTACT_FORM, { contact: null, changes: [] })).toBe(false);
  });

  it("say a phone and an address in words", () => {
    expect(phoneWords("+15125550143")).toBe("(512) 555-0143");
    expect(phoneWords("+442071838750")).toBe("+442071838750");
    expect(phoneWords(null)).toBe("");
    expect(addressLine(kept)).toBe("12 Elm St, Austin, TX 78704");
    expect(addressLine({ contact: null, changes: [] })).toBeNull();
  });
});

describe("saving from the phone", () => {
  it("posts the whole of it to the person's own route with a key, and returns what is kept", async () => {
    const { fetcher, calls } = fakeFetch(() => json(200, kept));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_abc", fetch: fetcher });
    const saved = await api.saveMyContact(contactBody(contactFormOf(kept)), "key-1");
    expect(saved).toEqual(kept);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ops.example.com/api/v1/me/contact");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer otd_abc");
    expect(headers["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      phone: "(512) 555-0143", addressLine1: "12 Elm St", addressLine2: null, city: "Austin", state: "TX", postalCode: "78704",
    });
  });

  it("reads the record from the person's own record", async () => {
    const { fetcher, calls } = fakeFetch(() => json(200, { membershipId: "m", ownContact: kept }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_abc", fetch: fetcher });
    expect(await api.myContact()).toEqual(kept);
    expect(calls[0]!.url).toBe("https://ops.example.com/api/v1/me");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("carries the server's own sentence when it refuses", async () => {
    const sentence = "The ZIP code is five digits, like 78701, or nine with a dash.";
    const { fetcher } = fakeFetch(() => json(409, { error: sentence }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_abc", fetch: fetcher });
    const refused = await api.saveMyContact(contactBody({ ...contactFormOf(kept), postalCode: "787" }), "key-2")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).message).toBe(sentence);
  });

  it("is no answer, not a refusal, when there is no signal, and says a sign in that ended", async () => {
    const down = fakeFetch(() => { throw new Error("network down"); });
    const offline = await new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_abc", fetch: down.fetcher })
      .saveMyContact(contactBody(EMPTY_CONTACT_FORM), "key-3").catch((error: unknown) => error);
    expect(offline).toBeInstanceOf(OfflineError);

    const ended = fakeFetch(() => json(401, { error: "Sign in" }));
    const signedOut = await new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_abc", fetch: ended.fetcher })
      .myContact().catch((error: unknown) => error);
    expect(signedOut).toBeInstanceOf(SignedOutError);
  });
});
