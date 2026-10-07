import { describe, expect, it } from "vitest";
import { trimTrailingSlashes } from "../src/url";

describe("trimTrailingSlashes", () => {
  it("takes every slash off the end and nothing else", () => {
    expect(trimTrailingSlashes("https://a.test///")).toBe("https://a.test");
    expect(trimTrailingSlashes("https://a.test/x/")).toBe("https://a.test/x");
    expect(trimTrailingSlashes("https://a.test")).toBe("https://a.test");
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });

  it("is linear on a very long run of slashes", () => {
    const started = Date.now();
    expect(trimTrailingSlashes("a" + "/".repeat(200_000) + "b/")).toBe("a" + "/".repeat(200_000) + "b");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
