import { describe, it, expect } from "vitest";
import { inflateSync, deflateSync } from "node:zlib";
import { estimate as est, pdf } from "../src/index";

/**
 * A PROPOSAL LAID OUT THE COMPANY'S WAY
 *
 * The layout is stored as data and drawn by two things, the page and the PDF,
 * so the rules about what a layout may hold are the only thing standing
 * between a template that saves and a customer's copy that leaves something
 * out. Each test is a layout that would have saved and then drawn wrongly.
 */

const options = { kind: "options", title: "Your options" };

describe("a layout", () => {
  it("keeps the sections in the order the company put them", () => {
    const decision = est.checkLayout({
      cover: { headline: "Your new system", intro: "Prepared after our visit.", photoKey: "org/abc.jpg" },
      sections: [
        { kind: "about", title: "Who we are", body: "Family owned since 1998." },
        { kind: "warranty", body: "Ten years parts and labour." },
        options,
        { kind: "reviews", minRating: 4, count: 2 },
        { kind: "terms" },
      ],
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.layout.sections.map((s) => s.kind)).toEqual(["about", "warranty", "options", "reviews", "terms"]);
    // A heading left empty is the kind's own.
    expect(decision.layout.sections[1]!.title).toBe("Our warranty");
    expect(decision.layout.sections[3]).toMatchObject({ minRating: 4, count: 2 });
    expect(decision.layout.cover).toEqual({ headline: "Your new system", intro: "Prepared after our visit.", photoKey: "org/abc.jpg" });
    expect(decision.layout.showOptionPhotos).toBe(true);
  });

  it("refuses a proposal with nothing on it to approve", () => {
    const decision = est.checkLayout({ sections: [{ kind: "about", body: "Hello" }] });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problems).toEqual([expect.stringContaining("The options have to be in the proposal")]);
  });

  it("refuses a kind it cannot draw, a section twice, and a section with no words, all at once", () => {
    const decision = est.checkLayout({
      cover: { headline: "" },
      sections: [options, { kind: "video", body: "x" }, options, { kind: "custom", title: "Our team" }],
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problems).toEqual([
      "The cover needs a headline, or take the cover off.",
      expect.stringContaining('Section 2 is a "video"'),
      "Section 4 (Our team) needs some words under it.",
      "Your options is in the proposal twice. It can be there once.",
    ]);
  });

  it("lets a company write several sections of its own", () => {
    const decision = est.checkLayout({
      sections: [options, { kind: "custom", title: "Our team", body: "Six people." }, { kind: "custom", title: "Rebates", body: "Ask us." }],
    });
    expect(decision.ok).toBe(true);
  });

  it("keeps no words of its own on the options or the terms, which draw the estimate's", () => {
    const decision = est.checkLayout({ sections: [{ kind: "options", body: "ignored" }, { kind: "terms", body: "not these" }] });
    expect(decision.ok && decision.layout.sections.map((s) => s.body)).toEqual([null, null]);
  });

  it("holds the reviews section to a rating and a count a page can show", () => {
    const decision = est.checkLayout({ sections: [options, { kind: "reviews", minRating: 7, count: 0 }] });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problems).toHaveLength(2);
  });

  it("draws an estimate with no layout, or one this build cannot read, in the fixed layout", () => {
    expect(est.layoutOrFixed(null)).toBe(est.FIXED_LAYOUT);
    expect(est.layoutOrFixed({ sections: [{ kind: "hologram" }] })).toBe(est.FIXED_LAYOUT);
    expect(est.FIXED_LAYOUT.sections.map((s) => s.kind)).toEqual(["options", "terms"]);
  });

  it("starts a new template from something worth editing that still saves", () => {
    expect(est.checkLayout(est.starterLayout("Lone Star Air")).ok).toBe(true);
  });

  it("moves a section up and down and never off the end", () => {
    const list = ["a", "b", "c"];
    expect(est.moveSection(list, 2, -1)).toEqual(["a", "c", "b"]);
    expect(est.moveSection(list, 0, -1)).toEqual(list);
    expect(est.moveSection(list, 2, 1)).toEqual(list);
  });
});

/** A one pixel JPEG and a two by one grey PNG, built byte by byte. */
function tinyJpeg(components = 3): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 8 + components * 3, 8, 0x00, 0x01, 0x00, 0x01, components,
    ...Array.from({ length: components }, (_, i) => [i + 1, 0x11, 0]).flat()];
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, ...sof, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

function chunk(type: string, body: number[]): number[] {
  const len = body.length;
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
    ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0];
}

function tinyPng(colourType: number): Uint8Array {
  const ihdr = [0, 0, 0, 2, 0, 0, 0, 1, 8, colourType, 0, 0, 0];
  const idat = [...deflateSync(Uint8Array.from([0, 10, 200]))];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr), ...chunk("IDAT", idat), ...chunk("IEND", [])]);
}

describe("a photograph in the PDF", () => {
  it("reads a JPEG's size and colour from its frame header and hands the bytes over whole", () => {
    const bytes = tinyJpeg();
    const image = pdf.readImage(bytes);
    expect(image).toMatchObject({ width: 1, height: 1, colorSpace: "DeviceRGB", filter: "DCTDecode" });
    expect(image!.data).toBe(bytes);
    expect(pdf.readImage(tinyJpeg(1))!.colorSpace).toBe("DeviceGray");
  });

  it("takes a plain PNG's compressed pixels with the PNG predictor, and refuses one with transparency", () => {
    const grey = pdf.readImage(tinyPng(0));
    expect(grey).toMatchObject({ width: 2, height: 1, colorSpace: "DeviceGray", filter: "FlateDecode" });
    expect(grey!.extra).toContain("/Predictor 15");
    expect(pdf.readImage(tinyPng(6))).toBeNull();
    expect(pdf.readImage(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
  });

  it("fits a photograph inside a box without changing its shape", () => {
    expect(pdf.fitWithin({ width: 4000, height: 3000 }, 400, 400)).toEqual({ width: 400, height: 300 });
    expect(pdf.fitWithin({ width: 1000, height: 2000 }, 400, 400)).toEqual({ width: 200, height: 400 });
  });

  it("writes the image once however many pages draw it, and the file still holds together", () => {
    const image = pdf.readImage(tinyJpeg())!;
    const first = new pdf.PdfPage();
    first.image(image, 48, 48, 100, 100);
    first.image(image, 48, 200, 50, 50);
    const second = new pdf.PdfPage();
    second.image(image, 48, 48, 100, 100);
    const bytes = pdf.renderPdf([first, second], { title: "Photos", createdAt: new Date("2026-06-15T12:00:00Z") });
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(1);
    expect(text).toContain("/XObject << /Im1");
    expect(pdf.inspectPdf(bytes).problems).toEqual([]);
  });

  it("draws a proposal in the company's order, with its cover first", () => {
    const bytes = pdf.proposalPdf({
      company: { name: "Lone Star Air", color: "#1F6FEB" },
      number: 12, title: null, status: "sent", issuedOn: "2026-06-01", expiresOn: null,
      decidedAt: null, signerName: null, selectedOptionId: null,
      customerName: "Pat Doe", propertyAddress: "1 Main St, Austin, TX 78701",
      terms: "Payment due on completion.",
      options: [{
        id: "o1", name: "Replace the condenser", description: null, tier: null, isRecommended: true,
        subtotal: "100.0000", discountTotal: "0", taxTotal: "0", total: "100.0000", optionalTotal: "0",
        lines: [{ name: "Condenser", description: null, quantity: "1", unitPrice: "100.0000", lineTotal: "100.0000",
          memberDiscountAmount: "0", memberPlan: null, isOptional: false, isSelected: true }],
        photos: [pdf.readImage(tinyJpeg()), null],
      }],
      layout: {
        cover: { headline: "Your new system", intro: null, photo: null, photoUnprintable: false },
        sections: [
          { kind: "about", title: "Who we are", body: "Family owned." },
          { kind: "options", title: "Your options", body: null },
          { kind: "reviews", title: "What customers say", body: null, reviews: [{ author: "Sam", rating: 5, body: "On time." }] },
          { kind: "terms", title: "The small print", body: null },
        ],
      },
      generatedAt: new Date("2026-06-15T12:00:00Z"),
    }, { deflate: (b) => new Uint8Array(deflateSync(b)) });
    const read = pdf.inspectPdf(bytes, (b) => new Uint8Array(inflateSync(b)));
    expect(read.problems).toEqual([]);
    expect(read.pages[0]).toContain("Your new system");
    const rest = read.pages.slice(1).flat();
    const order = ["Who we are", "Replace the condenser (recommended)", "What customers say", "The small print"]
      .map((heading) => rest.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rest.join(" ")).toContain("it is not a kind this file can print");
  });
});
