import { describe, it, expect } from "vitest";
import { createRouter, registeredRouters, minutesOf } from "../src/routing/index";

/**
 * THE THREE ROUTING SERVICES, WITHOUT A NETWORK
 *
 * Every request goes to a fake `fetch` that records what it was asked and
 * answers in the vendor's documented shape. What is checked is what goes out
 * (the coordinates in longitude, latitude order, which half are sources, the
 * key where each vendor takes it) and what comes back (seconds to whole
 * minutes, a missing road as null, a refusal as a failure rather than a
 * throw).
 */

interface Call { url: URL; init: RequestInit | undefined }

function fakeFetch(respond: (url: URL, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const yard = { lat: 30.3, lng: -97.7 };
const house = { lat: 30.25, lng: -97.75 };
const shed = { lat: 30.2, lng: -97.8 };

describe("the registry", () => {
  it("has all three under their catalogue keys", () => {
    expect(registeredRouters()).toEqual(expect.arrayContaining(["osrm", "mapbox_directions", "openrouteservice"]));
  });

  it("refuses a provider nobody registered", () => {
    expect(() => createRouter("google", { settings: {}, secret: null })).toThrow(/No routing provider/);
  });

  it("rounds seconds up to whole minutes, never zero between two places", () => {
    expect(minutesOf(61, false)).toBe(2);
    expect(minutesOf(20, false)).toBe(1);
    expect(minutesOf(0, true)).toBe(0);
    expect(minutesOf(null, false)).toBeNull();
  });
});

describe("OSRM", () => {
  it("asks its table endpoint with sources and destinations named, and reads minutes back", async () => {
    const fake = fakeFetch(() => json({ code: "Ok", durations: [[600, 125], [610, null]], distances: [[9000, 2000], [9100, null]] }));
    const router = createRouter("osrm", { settings: { endpoint: "https://osrm.test/" }, secret: null, fetch: fake.fn });
    const out = await router.matrix({ sources: [yard, house], destinations: [shed, yard] });
    // From the yard to the yard is no drive at all, whatever the table says.
    expect(out).toEqual({ kind: "ok", minutes: [[10, 0], [11, null]], meters: [[9000, 2000], [9100, null]] });
    const call = fake.calls[0]!;
    expect(call.url.pathname).toBe(
      "/table/v1/driving/-97.700000,30.300000;-97.750000,30.250000;-97.800000,30.200000;-97.700000,30.300000",
    );
    expect(call.url.searchParams.get("sources")).toBe("0;1");
    expect(call.url.searchParams.get("destinations")).toBe("2;3");
  });

  it("has no default server, because the public demo asks not to be used", async () => {
    const out = await createRouter("osrm", { settings: {}, secret: null }).matrix({ sources: [yard], destinations: [house] });
    expect(out).toMatchObject({ kind: "failed", retryable: false });
  });

  it("passes on what OSRM said when it refused", async () => {
    const fake = fakeFetch(() => json({ code: "TooBig", message: "Too many table coordinates" }));
    const out = await createRouter("osrm", { settings: { endpoint: "https://osrm.test" }, secret: null, fetch: fake.fn })
      .matrix({ sources: [yard], destinations: [house] });
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringContaining("TooBig") });
  });
});

describe("Mapbox", () => {
  it("puts the token where Mapbox takes it and asks the matrix API", async () => {
    const fake = fakeFetch(() => json({ code: "Ok", durations: [[300]], distances: [[4000]] }));
    const router = createRouter("mapbox_directions", { settings: {}, secret: "pk.test", fetch: fake.fn });
    const out = await router.matrix({ sources: [yard], destinations: [house] });
    expect(out).toMatchObject({ kind: "ok", minutes: [[5]] });
    expect(fake.calls[0]!.url.pathname).toContain("/directions-matrix/v1/mapbox/driving/");
    expect(fake.calls[0]!.url.searchParams.get("access_token")).toBe("pk.test");
    expect(router.maxPoints).toBe(25);
    expect(router.keepForSeconds).toBeLessThanOrEqual(86_400);
  });

  it("refuses to ask without a token, and calls a refused one a credential problem", async () => {
    expect(await createRouter("mapbox_directions", { settings: {}, secret: null }).matrix({ sources: [yard], destinations: [house] }))
      .toMatchObject({ kind: "failed", retryable: false });
    const fake = fakeFetch(() => new Response("nope", { status: 401 }));
    const out = await createRouter("mapbox_directions", { settings: {}, secret: "bad", fetch: fake.fn })
      .matrix({ sources: [yard], destinations: [house] });
    expect(out).toMatchObject({ kind: "failed", retryable: false, reason: expect.stringContaining("credential") });
  });

  it("calls a rate limit something to try again", async () => {
    const fake = fakeFetch(() => new Response("slow down", { status: 429 }));
    const out = await createRouter("mapbox_directions", { settings: {}, secret: "pk", fetch: fake.fn })
      .matrix({ sources: [yard], destinations: [house] });
    expect(out).toMatchObject({ kind: "failed", retryable: true });
  });
});

describe("OpenRouteService", () => {
  it("posts the coordinates in the body with the key as a header", async () => {
    const fake = fakeFetch(() => json({ durations: [[120, 240]], distances: [[1000, 2000]] }));
    const router = createRouter("openrouteservice", { settings: {}, secret: "ors-key", fetch: fake.fn });
    const out = await router.matrix({ sources: [yard], destinations: [house, shed] });
    expect(out).toMatchObject({ kind: "ok", minutes: [[2, 4]] });
    const call = fake.calls[0]!;
    expect(call.url.pathname).toBe("/v2/matrix/driving-car");
    expect(new Headers(call.init?.headers).get("authorization")).toBe("ors-key");
    expect(JSON.parse(String(call.init?.body))).toMatchObject({
      locations: [[-97.7, 30.3], [-97.75, 30.25], [-97.8, 30.2]], sources: [0], destinations: [1, 2],
    });
  });

  it("needs no key for a company's own server, and a key for the hosted one", async () => {
    const fake = fakeFetch(() => json({ durations: [[60]] }));
    const own = createRouter("openrouteservice", { settings: { endpoint: "https://ors.yard.test" }, secret: null, fetch: fake.fn });
    expect(await own.matrix({ sources: [yard], destinations: [house] })).toMatchObject({ kind: "ok" });
    expect(await createRouter("openrouteservice", { settings: {}, secret: null }).matrix({ sources: [yard], destinations: [house] }))
      .toMatchObject({ kind: "failed", retryable: false });
  });

  it("refuses a table of the wrong size rather than reading it wrong", async () => {
    const fake = fakeFetch(() => json({ durations: [[60]] }));
    const out = await createRouter("openrouteservice", { settings: {}, secret: "k", fetch: fake.fn })
      .matrix({ sources: [yard, house], destinations: [shed] });
    expect(out).toMatchObject({ kind: "failed" });
  });
});
