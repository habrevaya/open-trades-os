import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectors as cat } from "@opentradesos/core";

/**
 * THE QUEUE CANNOT GO STALE IN THE REASSURING DIRECTION
 *
 * `docs/integration-queue.md` is a plan: what to build next, hardest at the
 * bottom. A plan is allowed to be wrong about effort and allowed to change its
 * mind. What it is not allowed to do is disagree with the catalogue about what
 * already exists, and that is the one thing about it a reader will act on
 * without checking.
 *
 * The failure is specific. Something ships, the catalogue flips to `built`,
 * and the queue still carries it as work to do. Somebody picks it up, reads
 * the tier, and spends a day rebuilding a connector that was finished last
 * month. The same drift the other way is worse: the queue lists something in
 * its Tier 0 table that was never built, and a reader concludes the product
 * connects to something it does not.
 *
 * So this checks exactly two properties, both of them about the Tier 0 table
 * and nothing about the prose:
 *
 *   Everything the queue calls built IS built.
 *   Everything that is built IS in the queue's built table.
 *
 * The second is the one that catches the stale direction, and it is the
 * reason this test is worth having at all: without it the table can simply
 * fall behind and nothing anywhere notices.
 */
const doc = readFileSync(join(__dirname, "../../../docs/integration-queue.md"), "utf8");

/**
 * The Tier 0 table, read as data rather than by eye.
 *
 * Keys are in backticks in the first column, which is also how the catalogue
 * names them, so the two can be compared without anybody maintaining a third
 * list to join them by.
 */
function tierZeroKeys(): string[] {
  const start = doc.indexOf("## Tier 0");
  const end = doc.indexOf("## Tier 1");
  expect(start, "the queue has no Tier 0 section").toBeGreaterThan(-1);
  expect(end, "the queue has no Tier 1 section").toBeGreaterThan(start);

  const section = doc.slice(start, end);
  return [...section.matchAll(/^\|\s*`([a-z0-9_]+)`/gm)].map((m) => m[1]!);
}

describe("the integration queue agrees with the catalogue", () => {
  it("is read at all", () => {
    /**
     * The vacuous case. An empty document, or a Tier 0 table nothing matched,
     * would satisfy both sweeps below and report a clean bill of health.
     */
    expect(doc.length).toBeGreaterThan(2000);
    expect(tierZeroKeys().length).toBeGreaterThan(3);
    expect(cat.builtConnectors().length).toBeGreaterThan(3);
  });

  it("calls nothing built that is not", () => {
    const built = new Set(cat.builtConnectors().map((c) => c.key));
    const lying = tierZeroKeys().filter((key) => !built.has(key));

    expect(
      lying,
      "the queue lists these as already built and the catalogue does not, so a reader "
      + "would believe this product connects to something it does not",
    ).toEqual([]);
  });

  it("does not leave something built sitting in the queue", () => {
    /**
     * The direction that actually happens. Nobody forgets to add a row when
     * they are writing the feature; they forget weeks later, and by then the
     * queue reads as a backlog containing finished work.
     */
    const listed = new Set(tierZeroKeys());
    const missing = cat.builtConnectors()
      .map((c) => c.key)
      .filter((key) => !listed.has(key));

    expect(
      missing,
      "these connectors are built and the queue has not been updated: add them to the "
      + "Tier 0 table and take them out of whichever tier still proposes building them",
    ).toEqual([]);
  });

  it("does not propose building something that is already built", () => {
    /**
     * A QUEUE ITEM, NOT A MENTION, and the difference matters.
     *
     * The first version of this failed on `lead_webhook` and `spend_csv`,
     * which the later tiers name repeatedly and correctly: the lead
     * marketplaces section exists to say that the generic webhook already
     * receives all sixteen of them, and the supplier section reasons from why
     * a CSV importer beat the ad platform APIs. Those are the most useful
     * sentences in the document and a test that forbade them would have been
     * a test making the document worse.
     *
     * What is actually forbidden is a built connector appearing as a thing to
     * DO: a numbered heading in Tier 1, or the first cell of a row in one of
     * the tier tables. Those are the lines somebody picks work off.
     */
    const built = cat.builtConnectors().map((c) => c.key);

    /**
     * ONLY THE TIERS, because only the tiers are the queue.
     *
     * The document also carries a calibration table recording what past
     * builds actually cost, and those rows name built connectors on purpose:
     * "Email: Resend and SMTP, 267k" is a fact about history and the most
     * useful row in the section. Scanning everything after Tier 0 flagged it
     * as proposing work, which would have forced the estimates to be written
     * without naming what they were measured against.
     *
     * A tier heading starts a list of things to do. Everything else in the
     * file is reasoning about them.
     */
    /**
     * `$(?![\s\S])` is end of STRING, not end of line.
     *
     * With the `m` flag a bare `$` matches at every line break, so the lazy
     * body stopped at the first newline and every tier section came back five
     * characters long. The sweep then found no items and passed, which is the
     * worst way for a check like this to fail: it went green and stayed green.
     */
    const tiers = [...doc.matchAll(/^## Tier [1-9][^\n]*\n([\s\S]*?)(?=\n## |$(?![\s\S]))/gm)]
      .map((m) => m[1]!)
      .join("\n");

    const items = [
      ...[...tiers.matchAll(/^###\s+\d+\.\s*(.+)$/gm)].map((m) => m[1]!),
      ...[...tiers.matchAll(/^\|\s*([^|]+?)\s*\|/gm)].map((m) => m[1]!),
    ].join("\n");

    /**
     * THE WHOLE CELL, not a substring of it.
     *
     * Substring matching flagged a Tier 2 row reading "Reserve with Google",
     * which is Google's booking programme and has nothing to do with the
     * Gemini adapter keyed `google`. A rule that cannot tell those apart
     * either forces the queue to avoid a vendor's name or gets switched off,
     * and both are worse than the drift it was written to catch.
     */
    const cells = items.split("\n").map((line) => line.trim().toLowerCase());
    const proposed = built.filter((key) => {
      const bare = key.replace(/_/g, " ");
      return cells.some((cell) =>
        cell === key || cell === bare || cell === `\`${key}\``
        || cell.startsWith(`\`${key}\``));
    });

    expect(proposed, "named as a queue item and already built").toEqual([]);
  });
});
