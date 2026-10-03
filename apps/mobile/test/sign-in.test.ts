import { describe, it, expect } from "vitest";
import { signInPhone } from "../src/lib/sign-in";
import { parseSession, sessionExpired, deviceInstallationId } from "../src/lib/session";

/**
 * Signing the phone in, against a fake of the two routes it calls.
 *
 * What matters is the sequence and the words: the address is checked before
 * anything is sent, the token from the sign in is the one the device is
 * registered with, and every way it can fail comes back as a sentence the
 * person holding the phone can act on.
 */

const device = { installation: "install-1", platform: "ios" as const, label: "iPhone app", appVersion: "0.1.0" };

type Call = { url: string; init: RequestInit };

function server(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const happy = (call: Call) => {
  if (call.url.endsWith("/v1/field/sign-in")) {
    return json(201, {
      token: "otd_secret", expiresAt: "2026-12-31T00:00:00.000Z",
      user: { id: "user-1", name: "Ray Nunez", email: "ray@example.com" },
      organization: { id: "org-1", name: "Nunez Heating", timezone: "America/Chicago" },
    });
  }
  return json(201, { deviceId: "device-1", lastSequence: 41 });
};

describe("signing the phone in", () => {
  it("signs in, registers this phone with the new token, and keeps what it needs", async () => {
    const { fetcher, calls } = server(happy);
    const outcome = await signInPhone(
      { server: "ops.example.com/login", email: " Ray@Example.com ", password: "pw" }, device, fetcher,
    );

    expect(outcome).toEqual({
      ok: true,
      lastSequence: 41,
      session: {
        serverUrl: "https://ops.example.com", token: "otd_secret", expiresAt: "2026-12-31T00:00:00.000Z",
        deviceId: "device-1", userId: "user-1", email: "ray@example.com", name: "Ray Nunez",
        organizationName: "Nunez Heating", timezone: "America/Chicago",
      },
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://ops.example.com/api/v1/field/sign-in",
      "https://ops.example.com/api/v1/field/devices",
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "ray@example.com", password: "pw" });
    expect((calls[1]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer otd_secret");
    // One device per person per install, so a shared handset keeps two queues apart.
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      installationId: "install-1:user-1", platform: "ios", appVersion: "0.1.0",
    });
  });

  it("catches a bad address before sending a password anywhere", async () => {
    const { fetcher, calls } = server(happy);
    const outcome = await signInPhone({ server: "ftp://x", email: "a@b.co", password: "pw" }, device, fetcher);
    expect(outcome).toMatchObject({ ok: false, field: "server" });
    expect(calls).toHaveLength(0);
  });

  it("asks for an email that looks like one, and a password", async () => {
    const { fetcher } = server(happy);
    expect(await signInPhone({ server: "ops.example.com", email: "ray", password: "pw" }, device, fetcher))
      .toMatchObject({ ok: false, field: "email" });
    expect(await signInPhone({ server: "ops.example.com", email: "ray@example.com", password: "" }, device, fetcher))
      .toMatchObject({ ok: false, field: "password" });
  });

  it("passes on the server's own words for a wrong password", async () => {
    const { fetcher } = server(() => json(401, { error: "That email and password do not match", status: 401 }));
    expect(await signInPhone({ server: "ops.example.com", email: "ray@example.com", password: "x" }, device, fetcher))
      .toEqual({ ok: false, error: "That email and password do not match" });
  });

  it("says when the server cannot be reached at all", async () => {
    const fetcher = (async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch;
    const outcome = await signInPhone({ server: "ops.example.com", email: "ray@example.com", password: "x" }, device, fetcher);
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/Could not reach that server/) });
  });
});

describe("the saved session", () => {
  const good = {
    serverUrl: "https://ops.example.com", token: "otd_x", expiresAt: "2026-12-31T00:00:00.000Z",
    deviceId: "d", userId: "u", email: "e@x.co", name: null, organizationName: "Co", timezone: "America/Chicago",
  };

  it("reads back what was saved", () => {
    expect(parseSession(JSON.stringify(good))).toEqual(good);
  });

  it("reads a damaged or older one as signed out, never as a crash on launch", () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession("{not json")).toBeNull();
    expect(parseSession(JSON.stringify({ ...good, token: "" }))).toBeNull();
    expect(parseSession(JSON.stringify({ serverUrl: "x" }))).toBeNull();
  });

  it("knows when the token has run out", () => {
    const session = parseSession(JSON.stringify(good))!;
    expect(sessionExpired(session, new Date("2026-10-02T00:00:00Z"))).toBe(false);
    expect(sessionExpired(session, new Date("2027-01-01T00:00:00Z"))).toBe(true);
  });

  it("gives each person on the phone their own device", () => {
    expect(deviceInstallationId("abc", "u1")).not.toBe(deviceInstallationId("abc", "u2"));
  });
});
