import { describe, it, expect, beforeEach } from "vitest";
import {
  createGeocoder, registeredGeocoders, resetPace, PUBLIC_ENDPOINT, type Clock,
} from "../src/maps/index";

/**
 * THE TWO GEOCODERS, WITHOUT A NETWORK
 *
 * Every request goes to a fake `fetch` that records what it was asked and
 * answers with a body copied from the vendor's documented shape, and every
 * wait for the rate limit goes to a fake clock that records how long it was
 * asked to sleep. Nothing here can reach OpenStreetMap or Mapbox, which
 * matters twice over for the first: its usage policy is the reason this
 * adapter exists in the shape it does, and a test suite hammering it on
 * every CI run would be the first thing to break it.
 */

interface Call { url: URL; headers: Record<string, string> }

function fakeFetch(respond: (url: URL) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return respond(url);
  }) as typeof fetch;
  return { fn, calls };
}

function fakeClock(start = 1_000_000): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => { slept.push(ms); now += ms; },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ADDRESS = {
  query: "4102 Ramsey Ave, Austin, TX, 78756, US",
  address: {
    addressLine1: "4102 Ramsey Ave", addressLine2: null,
    city: "Austin", state: "TX", postalCode: "78756", country: "US",
  },
};

beforeEach(() => resetPace());

describe("the registry", () => {
  it("has both adapters registered under their catalogue keys", () => {
    expect(registeredGeocoders()).toEqual(expect.arrayContaining(["nominatim", "mapbox"]));
  });

  it("refuses a provider nobody registered", () => {
    expect(() => createGeocoder("google", { settings: {}, secret: null })).toThrow(/No geocoder/);
  });
});

describe("nominatim", () => {
  const house = [{
    lat: "30.3170", lon: "-97.7400", place_rank: 30, addresstype: "building",
    category: "building", type: "house", display_name: "4102, Ramsey Avenue, Austin",
  }];

  it("asks a structured question and says who is asking", async () => {
    const http = fakeFetch(() => json(house));
    const geocoder = createGeocoder("nominatim", {
      settings: { contactEmail: "office@ridgeline.example", countryCodes: ["US"] },
      secret: null, fetch: http.fn, clock: fakeClock(),
    });
    await geocoder.geocode(ADDRESS);

    const [call] = http.calls;
    expect(call!.url.origin + call!.url.pathname).toBe(`${PUBLIC_ENDPOINT}/search`);
    expect(call!.url.searchParams.get("street")).toBe("4102 Ramsey Ave");
    expect(call!.url.searchParams.get("postalcode")).toBe("78756");
    expect(call!.url.searchParams.get("countrycodes")).toBe("us");
    expect(call!.url.searchParams.get("email")).toBe("office@ridgeline.example");
    /**
     * The policy refuses a stock library agent. Ours names the product and
     * carries the operator's contact address.
     */
    expect(call!.headers["user-agent"]).toMatch(/^OpenTradesOS\/1\.0 .*contact office@ridgeline\.example$/);
  });

  it("reads a house as on the building", async () => {
    const geocoder = createGeocoder("nominatim", {
      settings: {}, secret: null, fetch: fakeFetch(() => json(house)).fn, clock: fakeClock(),
    });
    expect(await geocoder.geocode(ADDRESS)).toEqual({
      kind: "found", lat: 30.317, lng: -97.74, precision: "rooftop", label: "4102, Ramsey Avenue, Austin",
    });
  });

  it("calls a road a street and a postcode a postcode", async () => {
    const road = createGeocoder("nominatim", {
      settings: {}, secret: null, clock: fakeClock(),
      fetch: fakeFetch(() => json([{ lat: "30.3", lon: "-97.7", place_rank: 26, addresstype: "road" }])).fn,
    });
    expect(await road.geocode(ADDRESS)).toMatchObject({ precision: "street" });
    resetPace();
    const postcode = createGeocoder("nominatim", {
      settings: {}, secret: null, clock: fakeClock(),
      fetch: fakeFetch(() => json([{ lat: "30.3", lon: "-97.7", place_rank: 21, addresstype: "postcode" }])).fn,
    });
    expect(await postcode.geocode(ADDRESS)).toMatchObject({ precision: "postal_code" });
  });

  it("answers not found with a value rather than an error", async () => {
    const geocoder = createGeocoder("nominatim", {
      settings: {}, secret: null, fetch: fakeFetch(() => json([])).fn, clock: fakeClock(),
    });
    expect(await geocoder.geocode(ADDRESS)).toMatchObject({ kind: "not_found" });
  });

  it("calls a rate limit or a server error something to try again, and a refusal not", async () => {
    for (const [status, retryable] of [[429, true], [503, true], [403, false], [400, false]] as const) {
      resetPace();
      const geocoder = createGeocoder("nominatim", {
        settings: {}, secret: null, clock: fakeClock(),
        fetch: fakeFetch(() => new Response("nope", { status })).fn,
      });
      expect(await geocoder.geocode(ADDRESS), String(status)).toMatchObject({ kind: "failed", retryable });
    }
  });

  it("calls an unreachable server something to try again", async () => {
    const geocoder = createGeocoder("nominatim", {
      settings: {}, secret: null, clock: fakeClock(),
      fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch,
    });
    expect(await geocoder.geocode(ADDRESS)).toMatchObject({ kind: "failed", retryable: true });
  });

  it("never asks the public server more than once a second, and a setting cannot make it", async () => {
    const clock = fakeClock();
    const geocoder = createGeocoder("nominatim", {
      settings: { minIntervalMs: 10 }, secret: null, fetch: fakeFetch(() => json(house)).fn, clock,
    });
    await geocoder.geocode(ADDRESS);
    await geocoder.geocode(ADDRESS);
    await geocoder.geocode(ADDRESS);
    expect(clock.slept).toEqual([1_100, 1_100]);
  });

  it("shares the limit between two companies pointed at the same server", async () => {
    /**
     * The limit belongs to the server being asked. Two connections on one
     * deployment both using the public server get one request a second
     * between them, not one each.
     */
    const clock = fakeClock();
    const http = fakeFetch(() => json(house));
    const a = createGeocoder("nominatim", { settings: {}, secret: null, fetch: http.fn, clock });
    const b = createGeocoder("nominatim", { settings: {}, secret: null, fetch: http.fn, clock });
    await a.geocode(ADDRESS);
    await b.geocode(ADDRESS);
    expect(clock.slept).toEqual([1_100]);
  });

  it("lets the deployment's own server go at whatever pace the company sets", async () => {
    /**
     * A self hosted server is the deployment's `NOMINATIM_URL`. A company's
     * connection cannot name one: its `endpoint` is an endpoint override,
     * dropped before the adapter is built (secret-namespace.integration).
     */
    const previous = process.env["NOMINATIM_URL"];
    process.env["NOMINATIM_URL"] = "https://geo.ridgeline.example/";
    try {
      const clock = fakeClock();
      const http = fakeFetch(() => json(house));
      const geocoder = createGeocoder("nominatim", {
        settings: { endpoint: "https://elsewhere.example/", minIntervalMs: 0 },
        secret: null, fetch: http.fn, clock,
      });
      await geocoder.geocode(ADDRESS);
      await geocoder.geocode(ADDRESS);
      expect(clock.slept).toEqual([]);
      expect(http.calls.every((call) => call.url.href.startsWith("https://geo.ridgeline.example/search?"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["NOMINATIM_URL"];
      else process.env["NOMINATIM_URL"] = previous;
    }
  });
});

describe("mapbox", () => {
  const feature = (featureType: string, accuracy?: string) => ({
    type: "FeatureCollection",
    features: [{
      geometry: { coordinates: [-97.74, 30.317] },
      properties: {
        feature_type: featureType, full_address: "4102 Ramsey Avenue, Austin, Texas 78756",
        ...(accuracy ? { coordinates: { accuracy } } : {}),
      },
    }],
  });

  it("always asks for the permanent tier, with the token from the secret store", async () => {
    const http = fakeFetch(() => json(feature("address", "rooftop")));
    const geocoder = createGeocoder("mapbox", {
      settings: { countryCodes: ["us"] }, secret: "pk.test-token", fetch: http.fn, clock: fakeClock(),
    });
    const outcome = await geocoder.geocode(ADDRESS);

    const url = http.calls[0]!.url;
    expect(url.pathname).toBe("/search/geocode/v6/forward");
    expect(url.searchParams.get("permanent")).toBe("true");
    expect(url.searchParams.get("access_token")).toBe("pk.test-token");
    expect(url.searchParams.get("q")).toBe(ADDRESS.query);
    expect(outcome).toEqual({
      kind: "found", lat: 30.317, lng: -97.74, precision: "rooftop",
      label: "4102 Ramsey Avenue, Austin, Texas 78756",
    });
  });

  it("reads the precision Mapbox reports", async () => {
    for (const [type, accuracy, precision] of [
      ["address", "interpolated", "interpolated"],
      ["address", "approximate", "street"],
      ["street", undefined, "street"],
      ["postcode", undefined, "postal_code"],
      ["place", undefined, "locality"],
    ] as const) {
      resetPace();
      const geocoder = createGeocoder("mapbox", {
        settings: {}, secret: "pk.x", clock: fakeClock(), fetch: fakeFetch(() => json(feature(type, accuracy))).fn,
      });
      expect(await geocoder.geocode(ADDRESS), `${type} ${accuracy}`).toMatchObject({ precision });
    }
  });

  it("refuses to ask without a token, rather than sending one that is empty", async () => {
    const http = fakeFetch(() => json(feature("address", "rooftop")));
    const geocoder = createGeocoder("mapbox", { settings: {}, secret: null, fetch: http.fn, clock: fakeClock() });
    expect(await geocoder.geocode(ADDRESS)).toMatchObject({ kind: "failed", retryable: false });
    expect(http.calls).toHaveLength(0);
  });

  it("answers not found when there are no features", async () => {
    const geocoder = createGeocoder("mapbox", {
      settings: {}, secret: "pk.x", clock: fakeClock(),
      fetch: fakeFetch(() => json({ type: "FeatureCollection", features: [] })).fn,
    });
    expect(await geocoder.geocode(ADDRESS)).toMatchObject({ kind: "not_found" });
  });

  it("names the credential when Mapbox refuses it", async () => {
    const geocoder = createGeocoder("mapbox", {
      settings: {}, secret: "pk.x", clock: fakeClock(),
      fetch: fakeFetch(() => new Response("Not Authorized - Invalid Token", { status: 401 })).fn,
    });
    const outcome = await geocoder.geocode(ADDRESS);
    expect(outcome).toMatchObject({ kind: "failed", retryable: false });
    expect(outcome.kind === "failed" && outcome.reason).toMatch(/credential/);
  });
});
