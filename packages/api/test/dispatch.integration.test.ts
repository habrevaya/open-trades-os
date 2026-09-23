import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A request in, a response out, against a real database.
 *
 * The matcher is unit tested; this is the rest of the path: authorization,
 * schema validation, the handler, and the mapping from a domain error to a
 * status code. No web server, because the dispatcher takes a Request and
 * returns a Response and is deliberately framework free.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("dispatch:org");
const USER = fixtureId("dispatch:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

/** Signed in as whichever roles the test names, or nobody. */
const deps = (roles: Actor["roles"] | null) => ({
  db: db(),
  basePath: "/api",
  resolveSession: async (): Promise<ServiceContext | null> =>
    roles === null ? null : { actor: { userId: USER, organizationId: ORG, roles }, db: db() },
});

const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const ADDRESS = { line1: "1 Dispatch Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Dispatch Co", slug: "dispatch-http" });
});
afterAll(async () => { if (raw) await raw.end(); });

run("routing", () => {
  it("answers 404 for a path nobody serves", async () => {
    const res = await dispatch(request("GET", "/v1/nothing"), deps(["owner"]));
    expect(res.status).toBe(404);
  });

  it("answers 405 with an Allow header for the wrong method", async () => {
    // A 404 here sends an integrator hunting for a typo in a correct URL.
    const res = await dispatch(request("DELETE", "/v1/customers"), deps(["owner"]));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("strips the mount prefix", async () => {
    // The contracts say /v1/customers; Next.js route handlers live under /api.
    const res = await dispatch(request("GET", "/v1/customers?limit=1"), deps(["owner"]));
    expect(res.status).toBe(200);
  });

  it("does not strip a prefix the path does not start with", async () => {
    const res = await dispatch(
      new Request("http://localhost/v1/customers?limit=1"),
      { ...deps(["owner"]), basePath: "/api" },
    );
    expect(res.status).toBe(200);
  });
});

run("authorization", () => {
  it("refuses an anonymous caller on a session route", async () => {
    const res = await dispatch(request("GET", "/v1/customers"), deps(null));
    expect(res.status).toBe(401);
  });

  it("answers 403, not 401, when a caller is known and not allowed", async () => {
    // 401 tells a signed-in user to sign in again, which will not help.
    const res = await dispatch(
      request("POST", "/v1/properties", { address: ADDRESS }),
      deps(["technician"]),
    );
    expect(res.status).toBe(403);
  });

  it("serves a public route with no session at all", async () => {
    const res = await dispatch(
      request("GET", "/v1/public/services?organizationSlug=dispatch-http"),
      deps(null),
    );
    expect(res.status).toBe(200);
  });
});

run("input", () => {
  it("reports which field failed, not that something did", async () => {
    // An integrator fixes a request from "address.city: Required" and cannot
    // from "bad input".
    const res = await dispatch(
      request("POST", "/v1/properties", { address: { line1: "x" } }),
      deps(["owner"]),
    );
    expect(res.status).toBe(422);
    const body = await res.json() as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain("address.city");
  });

  it("rejects a body that is not JSON", async () => {
    const res = await dispatch(
      new Request("http://localhost/api/v1/properties", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{nope",
      }),
      deps(["owner"]),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a JSON array as a body", async () => {
    const res = await dispatch(request("POST", "/v1/properties", [1, 2]), deps(["owner"]));
    expect(res.status).toBe(400);
  });

  it("lets a path parameter win over a body that disagrees", async () => {
    // A body carrying a different id from the URL it was sent to is either a
    // mistake or an attempt. Either way the URL is the request.
    const created = await dispatch(
      request("POST", "/v1/properties", { address: ADDRESS }),
      deps(["owner"]),
    ).then((r) => r.json() as Promise<{ id: string }>);

    const res = await dispatch(
      request("GET", `/v1/properties/${created.id}`, undefined),
      deps(["owner"]),
    );
    const body = await res.json() as { id: string };
    expect(body.id).toBe(created.id);
  });

  it("coerces a query string into the types the contract wants", async () => {
    const res = await dispatch(request("GET", "/v1/customers?limit=2"), deps(["owner"]));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(body.data.length).toBeLessThanOrEqual(2);
  });

  it("names a query parameter that cannot be coerced", async () => {
    const res = await dispatch(request("GET", "/v1/customers?limit=lots"), deps(["owner"]));
    expect(res.status).toBe(422);
    const body = await res.json() as { issues: { path: string; message: string }[] };
    expect(body.issues[0]?.path).toBe("limit");
    expect(body.issues[0]?.message).toMatch(/number/i);
  });
});

run("responses", () => {
  it("answers 201 for a create", async () => {
    const res = await dispatch(request("POST", "/v1/properties", { address: ADDRESS }), deps(["owner"]));
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("answers 404 for a record that is not there", async () => {
    const res = await dispatch(
      request("GET", `/v1/properties/${fixtureId("dispatch:ghost")}`),
      deps(["owner"]),
    );
    expect(res.status).toBe(404);
  });

  it("answers 409 for a conflict", async () => {
    const code = `DISPATCH-${Date.now()}`;
    const body = { kind: "service", code, name: "Once", price: "10.00" };
    await dispatch(request("POST", "/v1/pricebook/items", body), deps(["owner"]));
    const again = await dispatch(request("POST", "/v1/pricebook/items", body), deps(["owner"]));
    expect(again.status).toBe(409);
  });

  it("honours an idempotency key from the header", async () => {
    // From the header and never the body: a client that regenerates its body
    // on retry would regenerate a key inside it.
    const key = `dispatch-${Date.now()}`;
    const send = () => dispatch(
      request("POST", "/v1/properties", { address: ADDRESS }, { "idempotency-key": key }),
      deps(["owner"]),
    ).then((r) => r.json() as Promise<{ id: string }>);

    const first = await send();
    const second = await send();
    expect(second.id).toBe(first.id);
  });

  it("does not echo an unknown error's detail", async () => {
    // A database constraint name or a query fragment in a browser is a leak.
    const res = await dispatch(request("GET", "/v1/customers"), {
      ...deps(["owner"]),
      resolveSession: async () => { throw new Error("connection string: postgres://secret"); },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
  });
});

run("the idempotency key reaches a route with no session", () => {
  /**
   * The header was read inside the session branch only, so three routes
   * declaring `idempotent: true` got nothing: the estimate approval, the
   * decline, and the public booking. The first two happen to be safe because
   * approving an already approved estimate returns the existing one. The
   * booking inserts a row, so a homeowner double tapping Book on a phone with
   * one bar made two requests and took two slots out of one window.
   *
   * Asserted THROUGH THE DISPATCHER rather than by calling the service, which
   * is the whole point: the service tests pass `meta` by hand and would stay
   * green with the dispatcher change reverted. This one goes red.
   */
  let serviceId = "";
  let windowId = "";

  beforeAll(async () => {
    if (!url) return;
    const [jt] = await raw<{ id: string }[]>`insert into public.job_type
      (organization_id, name, capacity_model)
      values (${ORG}, 'Tune up', 'technician_dispatch') returning id`;
    const [svc] = await raw<{ id: string }[]>`insert into public.bookable_service
      (organization_id, job_type_id, public_name, display_price, min_notice_hours,
       max_advance_days, max_per_window)
      values (${ORG}, ${jt!.id}, 'Seasonal tune up', 149.0000, 0, 30, 1) returning id`;
    serviceId = svc!.id;
    const [w] = await raw<{ id: string }[]>`insert into public.arrival_window
      (organization_id, name, starts_at, ends_at, days_of_week)
      values (${ORG}, '8am to 12pm', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]}) returning id`;
    windowId = w!.id;
    for (let d = 0; d < 7; d++) {
      await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
        values (${ORG}, ${d}, '07:00', '18:00')`;
    }
  });

  it("makes one booking out of two identical posts carrying the same key", async () => {
    const date = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
    const body = {
      organizationSlug: "dispatch-http", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Rae Sandoval", contactPhone: "5125550190",
      addressLine1: "12 Rockrose", city: "Austin", state: "TX", postalCode: "78702",
      intakeAnswers: {}, utm: {},
    };

    const post = () => dispatch(
      request("POST", "/v1/public/bookings", body, { "idempotency-key": "one-tap" }),
      deps(null),
    );

    const first = await post();
    const second = await post();

    expect(first.status).toBe(201);
    // Not a 409. The second tap is the first tap, and telling the person who
    // just booked that the time has gone is the worst available answer.
    expect(second.status).toBe(201);

    const rows = await raw`select id from public.booking_request
      where organization_id = ${ORG} and requested_date = ${date}`;
    expect(rows).toHaveLength(1);
  });
});
