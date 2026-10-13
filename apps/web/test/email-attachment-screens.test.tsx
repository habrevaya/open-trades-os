import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageFiles } from "../src/app/(app)/inbox/[id]/MessageFiles";

/**
 * WHAT CAME WITH AN EMAIL, IN THE THREAD (M18)
 *
 * A kept PDF is a download by the name it came with, through the thread's own
 * route; a kept picture is shown from it; a refused file says why. The email's
 * HTML is only ever kept as text, and drawn as text: a tag in it is shown as
 * characters, never as markup.
 */
const KEY = "org-1/ab/cd/abcdef.pdf";

describe("the files on a message", () => {
  it("offers a kept PDF as a download through the thread, and shows a kept picture", () => {
    const html = renderToStaticMarkup(<MessageFiles conversationId="c1" outbound={false} media={[
      { contentType: "application/pdf", storageKey: KEY, name: "Warranty card.pdf", bytes: 52_000 },
      { contentType: "image/png", storageKey: "org-1/ab/cd/f00d.png", name: "boiler.png" },
    ]} />);
    expect(html).toContain('href="/inbox/c1/media/org-1/ab/cd/abcdef.pdf?download=1"');
    expect(html).toContain("Download Warranty card.pdf");
    expect(html).toContain('src="/inbox/c1/media/org-1/ab/cd/f00d.png"');
    expect(html).toContain('alt="boiler.png"');
  });

  it("says why a file was not kept", () => {
    const html = renderToStaticMarkup(<MessageFiles conversationId="c1" outbound={false} media={[
      { contentType: "application/x-msdownload", refused: "pay.exe came with this email and was not kept: it is a program." },
    ]} />);
    expect(html).toContain("pay.exe came with this email and was not kept");
    expect(html).not.toContain("href=");
  });

  it("draws the email's HTML text as text, so markup in it never runs", () => {
    const html = renderToStaticMarkup(<MessageFiles conversationId="c1" outbound={false} media={[]}
      body="Thanks." htmlText={"Thanks. <script>alert(1)</script> <img src=x onerror=alert(1)>"} />);
    expect(html).toContain("The email as it was laid out, as text");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
  });

  it("does not repeat the words when the formatted part says no more than the plain one", () => {
    const html = renderToStaticMarkup(<MessageFiles conversationId="c1" outbound={false} media={[]} body="Same." htmlText="Same." />);
    expect(html).not.toContain("laid out");
  });
});
