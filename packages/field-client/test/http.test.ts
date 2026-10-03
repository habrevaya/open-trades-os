import { describe, it, expect } from "vitest";
import {
  FieldApi, ApiError, OfflineError, SignedOutError, isOffline, isSignedOut, normalizeServerUrl,
  FieldQueue, MemoryStorage,
} from "../src/index";

/**
 * The phone's side of every request, with fetch faked.
 *
 * What is under test is the classification, because the queue's behaviour
 * hangs on it: no answer and an ended sign in must never count as a try, and
 * an answer must always carry the server's own words to the screen.
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

describe("the address somebody types", () => {
  it("adds https when they leave it off", () => {
    expect(normalizeServerUrl("ops.example.com")).toEqual({
      ok: true, url: "https://ops.example.com", insecure: false,
    });
  });

  it("drops a trailing slash and the page they copied it from", () => {
    expect(normalizeServerUrl(" https://ops.example.com/login/ ")).toMatchObject({ url: "https://ops.example.com" });
    expect(normalizeServerUrl("https://ops.example.com/api")).toMatchObject({ url: "https://ops.example.com" });
    expect(normalizeServerUrl("https://ops.example.com/my-day?date=2026-10-02")).toMatchObject({
      url: "https://ops.example.com",
    });
  });

  it("keeps a port and a path the app is served under", () => {
    expect(normalizeServerUrl("http://192.168.1.20:3000/ots")).toEqual({
      ok: true, url: "http://192.168.1.20:3000/ots", insecure: true,
    });
  });

  it("says plainly when it is not an address at all", () => {
    expect(normalizeServerUrl("")).toMatchObject({ ok: false });
    expect(normalizeServerUrl("ftp://ops.example.com")).toMatchObject({ ok: false });
    expect(normalizeServerUrl("https://")).toMatchObject({ ok: false });
  });
});

describe("requests", () => {
  it("sends the token, as a bearer, to the API under the server address", async () => {
    const { fetcher, calls } = fakeFetch(() => json(200, { uploads: [] }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com/", token: "otd_abc", fetch: fetcher });
    await api.owedUploads("d1");
    expect(calls[0]!.url).toBe("https://ops.example.com/api/v1/field/uploads?deviceId=d1");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer otd_abc");
  });

  it("does not send a token with the sign in itself", async () => {
    const { fetcher, calls } = fakeFetch(() => json(201, { token: "otd_new" }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "otd_old", fetch: fetcher });
    await api.signIn({ email: "ray@example.com", password: "pw" });
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "ray@example.com", password: "pw" });
  });

  it("asks for the snapshot with only the inputs it has", async () => {
    const { fetcher, calls } = fakeFetch(() => json(200, { revision: 1, unchanged: true, visits: [], openTimeEntry: null }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "t", fetch: fetcher });
    await api.snapshot({ deviceId: "d1", from: "2026-10-02", days: 2 });
    await api.snapshot({ deviceId: "d1", from: "2026-10-02", days: 2, sinceRevision: 7 });
    expect(calls[0]!.url).toBe("https://ops.example.com/api/v1/field/snapshot?deviceId=d1&from=2026-10-02&days=2");
    expect(calls[1]!.url).toContain("sinceRevision=7");
  });

  it("carries an idempotency key on the text to the customer, so a double tap texts once", async () => {
    const { fetcher, calls } = fakeFetch(() => json(201, { sent: true, alreadySent: false, reason: null }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "t", fetch: fetcher });
    await api.onMyWay("v1", 15, "key-1");
    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel: "sms", etaMinutes: 15, includeTracking: true });
  });
});

describe("what an answer means", () => {
  it("no connection at all is offline, not a refusal", async () => {
    const api = new FieldApi({
      serverUrl: "https://ops.example.com", token: "t",
      fetch: (async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch,
    });
    const error = await api.owedUploads("d1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfflineError);
    expect(isOffline(error)).toBe(true);
  });

  it("gives up on a request that hangs, and calls that offline too", async () => {
    const api = new FieldApi({
      serverUrl: "https://ops.example.com", token: "t", timeoutMs: 10,
      fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch,
    });
    expect(isOffline(await api.owedUploads("d1").catch((e: unknown) => e))).toBe(true);
  });

  it("a refused token is the sign in ending, and is not counted against the work", async () => {
    const { fetcher } = fakeFetch(() => json(401, { error: "Not signed in", status: 401 }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "t", fetch: fetcher });
    const error = await api.owedUploads("d1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignedOutError);
    expect(isSignedOut(error)).toBe(true);
    expect(isOffline(error)).toBe(true);

    // And the queue keeps the operation untouched behind it.
    const q = new FieldQueue({ storage: new MemoryStorage(), deviceId: "d1", newId: () => crypto.randomUUID() });
    await q.enqueue({ kind: "timeclock.punch_in" });
    await q.flush(api.transport());
    expect((await q.pending())[0]!.attempts).toBe(0);
  });

  it("a wrong password is an answer, in the server's words", async () => {
    const { fetcher } = fakeFetch(() => json(401, { error: "That email and password do not match", status: 401 }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", fetch: fetcher });
    const error = await api.signIn({ email: "a@b.c", password: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe("That email and password do not match");
  });

  it("a server being restarted behind its proxy is offline, not a fault", async () => {
    const { fetcher } = fakeFetch(() => new Response("Bad Gateway", { status: 502 }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "t", fetch: fetcher });
    expect(isOffline(await api.owedUploads("d1").catch((e: unknown) => e))).toBe(true);
  });

  it("an address that is not one of ours says so, rather than 'not found'", async () => {
    const { fetcher } = fakeFetch(() => new Response("<html>nope</html>", { status: 404 }));
    const api = new FieldApi({ serverUrl: "https://example.com", fetch: fetcher });
    const error = await api.signIn({ email: "a@b.c", password: "x" }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/not as an OpenTradesOS server/);
  });

  it("a refusal of the whole batch is counted, because retrying it forever would hide it", async () => {
    const { fetcher } = fakeFetch(() => json(409, { error: "This device has been revoked.", status: 409 }));
    const api = new FieldApi({ serverUrl: "https://ops.example.com", token: "t", fetch: fetcher });
    const q = new FieldQueue({ storage: new MemoryStorage(), deviceId: "d1", newId: () => crypto.randomUUID() });
    await q.enqueue({ kind: "timeclock.punch_in" });
    const result = await q.flush(api.transport());
    expect(result.error).toBe("This device has been revoked.");
    expect((await q.pending())[0]!.attempts).toBe(1);
  });
});
