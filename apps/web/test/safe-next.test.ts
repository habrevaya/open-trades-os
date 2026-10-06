import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

/**
 * The sign in page follows `next`, so every way of writing "somewhere else"
 * has to come back null: this is the open redirect a phishing kit looks for.
 */
describe("where a sign in may send somebody", () => {
  it("keeps a path on this site, with its query", () => {
    expect(safeNext("/settings/apps/requests/abc")).toBe("/settings/apps/requests/abc");
    expect(safeNext("/oauth/authorize?client_id=x&state=y")).toBe("/oauth/authorize?client_id=x&state=y");
  });

  it.each([
    ["a full address", "https://evil.example/login"],
    ["a protocol relative address", "//evil.example"],
    ["a backslash the browser reads as a slash", "/\\evil.example"],
    ["a tab inside the slashes", "/\t/evil.example"],
    ["a newline", "/\nevil"],
    ["a relative path", "settings"],
    ["a javascript address", "javascript:alert(1)"],
    ["nothing", ""],
  ])("refuses %s", (_, value) => {
    expect(safeNext(value)).toBeNull();
  });

  it("refuses anything that is not text", () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext(["/a"])).toBeNull();
  });

  it("cuts a very long path rather than carrying it", () => {
    expect(safeNext(`/${"a".repeat(5000)}`)!.length).toBe(2000);
  });
});
