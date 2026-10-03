import { describe, it, expect } from "vitest";
import { PUSH_CHANNELS, type PriceBookEntry } from "@opentradesos/field-client";
import { CHANNELS, projectIdFrom, pushLine, visitFromNotice } from "../src/lib/push";
import { missingReadings, parseQuantity, searchPriceBook } from "../src/lib/work";
import { requestPhoneCode, signInPhoneWithCode } from "../src/lib/sign-in";

/**
 * What the phone decides about notices, parts, readings and a code sign in,
 * without the phone. The operating system calls are in `src/platform`; the
 * choices they act on are here.
 */

describe("notices about the day", () => {
  it("makes the two channels the server sends to, one loud and one quiet", () => {
    expect(CHANNELS.map((c) => c.id)).toEqual([PUSH_CHANNELS.normal, PUSH_CHANNELS.quiet]);
    expect(CHANNELS.find((c) => c.id === PUSH_CHANNELS.quiet)?.sound).toBe(false);
  });

  it("opens the visit a tapped notice names, and nothing for anything else", () => {
    const id = "6f1c2b9e-0a4d-4f39-9c7e-2b8a1d3e5f60";
    expect(visitFromNotice({ visitId: id, kind: "cancelled" })).toBe(id);
    expect(visitFromNotice({ visitId: "../../etc" })).toBeNull();
    expect(visitFromNotice(null)).toBeNull();
    expect(visitFromNotice("visit")).toBeNull();
  });

  it("finds the push project id where EAS writes it", () => {
    expect(projectIdFrom({ expoConfig: { extra: { eas: { projectId: "abc-123" } } } })).toBe("abc-123");
    expect(projectIdFrom({ easConfig: { projectId: "def" } })).toBe("def");
    expect(projectIdFrom({ expoConfig: null })).toBeNull();
  });

  it("says something only when notices are not on", () => {
    expect(pushLine("on")).toBeNull();
    expect(pushLine("off")).toBeNull();
    expect(pushLine("denied")).toMatch(/Turn them on in the phone's settings/);
    expect(pushLine("unavailable")).toMatch(/cannot get notices/);
  });
});

describe("parts and readings", () => {
  const book: PriceBookEntry[] = [
    { id: "1", versionId: "v1", code: "CAP45", name: "Capacitor 45/5 MFD", unitPrice: "38.0000", taxable: true },
    { id: "2", versionId: "v2", code: null, name: "Contactor 2 pole", unitPrice: "42.0000", taxable: true },
    { id: "3", versionId: "v3", code: "FLT", name: "Filter 16x25x1", unitPrice: "12.0000", taxable: true },
  ];

  it("finds a part by every word typed, or by its code first", () => {
    expect(searchPriceBook(book, "cap 45").map((i) => i.versionId)).toEqual(["v1"]);
    expect(searchPriceBook(book, "flt").map((i) => i.versionId)).toEqual(["v3"]);
    expect(searchPriceBook(book, "co").map((i) => i.versionId)).toEqual(["v2"]);
    expect(searchPriceBook(book, "   ")).toEqual([]);
    expect(searchPriceBook(book, "c", 1)).toHaveLength(1);
  });

  it("reads a quantity with up to two places and nothing else", () => {
    expect(parseQuantity("2")).toBe("2");
    expect(parseQuantity("1.5")).toBe("1.5");
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("1.333")).toBeNull();
    expect(parseQuantity("two")).toBeNull();
  });

  it("names the required readings still empty before the report is sent", () => {
    expect(missingReadings([
      { label: "Suction pressure", required: true, value: null },
      { label: "Superheat", required: true, value: "12" },
      { label: "Notes", required: false, value: null },
    ])).toEqual(["Suction pressure"]);
  });
});

describe("signing in with a code", () => {
  const device = { installation: "install-1", platform: "android" as const, label: "Android app" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("asks for a code and shows the server's own sentence", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${String(init.body)}`);
      return json(201, { ok: true, message: "If that email belongs to a technician, a code is on its way to it." });
    }) as unknown as typeof fetch;
    const sent = await requestPhoneCode({ server: "ops.example.com", email: " Ray@Example.com ", channel: "email" }, fetcher);
    expect(sent).toEqual({ ok: true, message: "If that email belongs to a technician, a code is on its way to it." });
    expect(calls).toEqual(['https://ops.example.com/api/v1/field/sign-in/code {"email":"ray@example.com","channel":"email"}']);
  });

  it("trades the code for a token and registers this phone with it", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/verify")) {
        return json(201, {
          token: "otd_code", expiresAt: "2026-12-31T00:00:00.000Z",
          user: { id: "user-1", name: "Ray", email: "ray@example.com" },
          organization: { id: "org-1", name: "Nunez Heating", timezone: "America/Chicago" },
        });
      }
      return json(201, { deviceId: "device-1", lastSequence: 3 });
    }) as unknown as typeof fetch;
    const outcome = await signInPhoneWithCode({ server: "ops.example.com", email: "ray@example.com", code: "123 456" }, device, fetcher);
    expect(outcome).toMatchObject({ ok: true, lastSequence: 3, session: { token: "otd_code", deviceId: "device-1" } });
    expect(urls).toEqual([
      "https://ops.example.com/api/v1/field/sign-in/verify",
      "https://ops.example.com/api/v1/field/devices",
    ]);
  });

  it("catches a short code before asking, and says a wrong one in the server's words", async () => {
    const never = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
    expect(await signInPhoneWithCode({ server: "ops.example.com", email: "ray@example.com", code: "12345" }, device, never))
      .toEqual({ ok: false, error: "Enter the six digit code from the text or email.", field: "code" });

    const refused = (async () => json(401, { error: "That code is not right, or it has expired. Ask for a new one." })) as unknown as typeof fetch;
    expect(await signInPhoneWithCode({ server: "ops.example.com", email: "ray@example.com", code: "123456" }, device, refused))
      .toEqual({ ok: false, error: "That code is not right, or it has expired. Ask for a new one." });
  });
});
