import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoBanner } from "../src/components/DemoBanner";

/**
 * THE DEMO SAYS IT IS ONE
 *
 * The read only guarantee is the server's (packages/api/test/demo.integration
 * .test.ts). What this checks is the sentence a visitor reads, and that the
 * shell shows it for a demo session and only for one.
 */
describe("the demo banner", () => {
  it("says nothing is saved, and links back to the website", () => {
    const html = renderToStaticMarkup(<DemoBanner website="https://example.test/" />);
    expect(html).toContain("viewing a demo company. Nothing you do here is saved.");
    expect(html).toContain('href="https://example.test/"');
    expect(html).toContain("Back to the website");
  });

  it("is in the shell, for a demo session only", () => {
    const shell = readFileSync(join(import.meta.dirname, "../src/components/AppShell.tsx"), "utf8");
    expect(shell).toMatch(/\{user\.demo && <DemoBanner \/>\}/);
  });
});
