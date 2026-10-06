import { describe, it, expect } from "vitest";
import { directMail as dm } from "../src/index";

/**
 * WHAT A MAILING MAY PRINT, AND WHAT IT COSTS
 */
describe("a mail design", () => {
  it("prints each person's own address, fills only what it knows, and has a back when it is a card", () => {
    expect(dm.checkDesign({ kind: "postcard", front: "<p>Hi</p>", back: "<p>{{ mail.url }}</p>" })).toEqual({ ok: true });
    expect(dm.checkDesign({ kind: "postcard", front: "<p>Hi</p>", back: "" })).toMatchObject({ ok: false });
    expect(dm.checkDesign({ kind: "letter", front: "{{ mail.url }}", back: "x" })).toMatchObject({ ok: false });
    expect(dm.checkDesign({ kind: "postcard", front: "{{ customer.nickname }}", back: "{{ mail.url }}" }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("customer.nickname") });
    expect(dm.checkDesign({ kind: "letter", front: "<p>Call us</p>", back: null })).toMatchObject({ ok: false, reason: expect.stringContaining("mail.url") });
  });

  it("escapes every value it prints, because a name is not markup", () => {
    const scope = dm.mailScope({
      customerName: "Lopez & Sons <b>", companyName: "A&B", companyPhone: null, url: "https://x/m/abc", phone: "(512) 555-0199", code: "abc",
    });
    expect(scope).toMatchObject({
      customer: { firstName: "Lopez", name: "Lopez &amp; Sons &lt;b&gt;" }, company: { name: "A&amp;B", phone: "" },
      mail: { phone: "(512) 555-0199" },
    });
    expect(dm.printedPhone("+15125550199")).toBe("(512) 555-0199");
  });
});

describe("an address and a code", () => {
  it("posts only a street, a town, a two letter state and a ZIP", () => {
    const at = { name: "A", line1: "1 Main St", line2: null, city: "Austin", state: "TX", postalCode: "78701" };
    expect(dm.checkAddress(at)).toEqual({ ok: true });
    expect(dm.checkAddress({ ...at, line1: null, city: null, postalCode: null })).toEqual({ ok: false, reason: "no_address" });
    expect(dm.checkAddress({ ...at, state: "Texas" })).toEqual({ ok: false, reason: "incomplete_address" });
    expect(dm.checkAddress({ ...at, postalCode: "787" })).toEqual({ ok: false, reason: "incomplete_address" });
  });

  it("makes codes of letters nobody misreads, ten long, without bias", () => {
    const code = dm.codeFrom(new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 7)))!;
    expect(dm.isMailCode(code)).toBe(true);
    expect(code).not.toMatch(/[01ilo]/);
    expect(dm.codeFrom(new Uint8Array([255, 255, 255]))).toBeNull();
    expect(dm.mailUrl("https://x.test/", code)).toBe(`https://x.test/m/${code}`);
  });

  it("costs the price per piece times the pieces, exactly", () => {
    expect(dm.mailCost(3, "0.72")).toBe("2.1600");
    expect(dm.mailCost(0, "0.72")).toBe("0.0000");
    expect(dm.mailCost(5, null)).toBe("0.0000");
  });
});
