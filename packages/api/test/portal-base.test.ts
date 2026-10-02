import { describe, it, expect } from "vitest";
import { portalBase } from "../src/lib/portal-base";

/**
 * Every link a customer is sent is built on this, and it read a variable no
 * example file mentions. A deployment configured with PUBLIC_URL, the way
 * .env.example says to, sent customers to portal.example.com.
 */
describe("where customer links point", () => {
  it("is the deployment's own address when only PUBLIC_URL is set", () => {
    expect(portalBase({ PUBLIC_URL: "https://ops.ridgeline.example/" })).toBe("https://ops.ridgeline.example");
  });

  it("honours AUTH_URL, the older name for the same address", () => {
    expect(portalBase({ AUTH_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  it("lets a portal on its own host win", () => {
    expect(portalBase({ PORTAL_BASE_URL: "https://pay.ridgeline.example", PUBLIC_URL: "https://ops.ridgeline.example" }))
      .toBe("https://pay.ridgeline.example");
  });

  it("falls back to the example domain only when nothing is configured", () => {
    expect(portalBase({})).toBe("https://portal.example.com");
  });
});
