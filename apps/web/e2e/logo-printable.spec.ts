import { eq, and } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A WEBP OR AN SVG LOGO PRINTS ON THE PDF
 *
 * The PDF writer prints a PNG or a JPEG, so a WebP logo kept from before was
 * left off every estimate and invoice; the settings screen now says so. Chosen
 * again on that screen, the browser turns it into a PNG before it is sent, and
 * the PDF carries it. An SVG with a script and a picture from somewhere else
 * in it is drawn as a plain picture, fetches nothing, and is stored as a PNG:
 * the server never receives the SVG.
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="40" viewBox="0 0 120 40">
  <script>document.title = "ran"; fetch("https://evil.example/ran");</script>
  <image xlink:href="https://evil.example/pixel.png" width="10" height="10"/>
  <rect width="120" height="40" fill="#1d4ed8"/>
</svg>`;

test("a WebP or SVG logo is sent as a PNG and prints on the PDF", async ({ owner }) => {
  const db = createClient();
  const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
    .where(eq(schema.organization.slug, "ridgeline")).limit(1);
  const where = and(eq(schema.brandAsset.organizationId, org!.id), eq(schema.brandAsset.kind, "logo"));
  const [kept] = await db.select().from(schema.brandAsset).where(where).limit(1);

  let fetchedElsewhere = false;
  await owner.context().route("https://evil.example/**", async (route) => {
    fetchedElsewhere = true;
    await route.abort();
  });

  try {
    // A real WebP, made by the browser, kept the way one was before this screen turned them into PNGs.
    await owner.goto("/settings");
    const webp = Buffer.from(await owner.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 24;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#c2410c";
      context.fillRect(0, 0, 48, 24);
      return canvas.toDataURL("image/webp").split(",")[1]!;
    }), "base64");
    expect(webp.subarray(8, 12).toString("latin1")).toBe("WEBP");
    await db.update(schema.brandAsset)
      .set({ bytes: webp, contentType: "image/webp", sizeBytes: webp.length, updatedAt: new Date() })
      .where(where);

    await owner.reload();
    const logo = owner.locator("div.rounded-lg").filter({ has: owner.getByLabel("Logo file") });
    await expect(logo).toContainText("Your estimate and invoice PDFs leave this logo off");

    await logo.getByLabel("Logo file").setInputFiles({ name: "mark.webp", mimeType: "image/webp", buffer: webp });
    await expect(logo.getByRole("status")).toHaveText("Your WebP will be sent as a PNG, so it prints on PDFs.");
    await logo.getByRole("button", { name: "Replace" }).click();
    await expect(owner.locator("div.rounded-lg").filter({ has: owner.getByLabel("Logo file") }))
      .not.toContainText("leave this logo off");
    const asPng = await owner.request.get("/brand/logo");
    expect(asPng.headers()["content-type"]).toContain("image/png");

    // An estimate's PDF carries it.
    const customerId = await newCustomer(owner, {
      name: `Printed Logo ${run}`, address: { street: "4 Letterhead Ln", city: "Austin", state: "TX", zip: "78701" },
    });
    const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
    const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
    const made = await owner.request.post("/api/v1/estimates", {
      data: {
        customerId, propertyId, title: `Logo check ${run}`, expiresOn: companyToday(),
        options: [{ name: "One", isRecommended: true, lines: [{ name: "Check", quantity: "1", unitPrice: "10.00", discountAmount: "0", taxable: false }] }],
      },
    });
    const estimateId = ((await made.json()) as { id: string }).id;
    const printed = await owner.request.get(`/estimates/${estimateId}/pdf`);
    expect(printed.status()).toBe(200);
    expect((await printed.body()).toString("latin1")).toContain("/Subtype /Image");

    // An SVG: drawn as a picture, nothing run, nothing fetched, kept as a PNG.
    await owner.goto("/settings");
    const again = owner.locator("div.rounded-lg").filter({ has: owner.getByLabel("Logo file") });
    await again.getByLabel("Logo file").setInputFiles({ name: "mark.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SVG) });
    await expect(again.getByRole("status")).toHaveText("Your SVG will be sent as a PNG, so it prints on PDFs.");
    await again.getByRole("button", { name: "Replace" }).click();
    await expect.poll(async () => (await owner.request.get("/brand/logo")).headers()["content-type"]).toContain("image/png");
    const [stored] = await db.select({ bytes: schema.brandAsset.bytes, contentType: schema.brandAsset.contentType })
      .from(schema.brandAsset).where(where).limit(1);
    expect(stored!.contentType).toBe("image/png");
    expect(Buffer.from(stored!.bytes).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(Buffer.from(stored!.bytes).toString("latin1")).not.toContain("<script");
    expect(fetchedElsewhere).toBe(false);
    expect(await owner.title()).not.toBe("ran");
  } finally {
    if (kept) {
      await db.update(schema.brandAsset)
        .set({ bytes: kept.bytes, contentType: kept.contentType, sizeBytes: kept.sizeBytes, updatedAt: new Date() })
        .where(where);
    }
    await db.$close();
  }
});
