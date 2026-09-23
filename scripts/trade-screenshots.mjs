#!/usr/bin/env node
/**
 * ONE PRICE BOOK PER TRADE
 *
 * The main capture script shoots the HVAC demo company, because the day's
 * work in the seed is written as HVAC: real job summaries, a real board, a
 * real proposal. This one shoots the single screen that is genuinely
 * different for every trade, and it does it by seeding each pack in turn.
 *
 * The price book is the right screen for this. It is the first thing a
 * contractor opens to decide whether anybody who built this has met their
 * trade, and it is the one place the pack's own data reaches the screen with
 * no fixtures in between. An electrician sees panels and conduit and a
 * service upgrade; a pest control operator sees quarterly plans and a
 * termite bait station. Nothing about that is written by a marketer.
 *
 * Usage, with a dev server already running and a database it can write to:
 *
 *   node scripts/trade-screenshots.mjs --out ./shots/trades
 *
 * It reseeds the database once per trade and leaves it holding whichever
 * trade came last, so `pnpm db:seed` afterwards to get the demo company
 * back. Said here because forgetting it is the obvious way to be confused
 * for ten minutes.
 */
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { HIDE_DEV } from "./hide-dev.mjs";

/**
 * The trade ids, read out of the pack files.
 *
 * Not imported from `@opentradesos/trade-packs`, which is TypeScript source
 * that this plain script cannot load, and not a list typed out here, which
 * would silently miss the ninth pack somebody adds. The id is read from the
 * file rather than taken from its name, because the two are free to differ
 * and a screenshot named after the wrong trade is the failure this whole
 * script exists to avoid.
 */
const PACKS = join(import.meta.dirname, "../packages/trade-packs/packs");
const packIds = readdirSync(PACKS)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(PACKS, f), "utf8").match(/\bid:\s*"([a-z0-9-]+)"/)?.[1])
  .filter((id) => id !== undefined)
  .sort();

if (packIds.length === 0) {
  console.error("\n  Found no trade packs. Is packages/trade-packs/packs still there?\n");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "./shots/trades" },
    base: { type: "string", default: "http://localhost:3000" },
    browser: { type: "string", default: process.env["CHROMIUM_PATH"] ?? "" },
    only: { type: "string", default: "" },
  },
});

const WIDTH = 1440;
const HEIGHT = 1000;


const wanted = values.only ? values.only.split(",") : packIds;

mkdirSync(values.out, { recursive: true });
const browser = await chromium.launch(
  values.browser ? { executablePath: values.browser } : {},
);

let failed = 0;
for (const packId of wanted) {
  if (!packIds.includes(packId)) {
    console.log(`  FAIL  ${packId.padEnd(20)} no such trade pack`);
    failed += 1;
    continue;
  }

  /**
   * Reseeded per trade, synchronously, because the app reads one database.
   * Running these in parallel would have each capture racing whichever seed
   * finished last, and the failure mode is a screenshot of the wrong trade,
   * which nobody notices until it is on a marketing page.
   */
  const output = execFileSync(
    "pnpm",
    ["-s", "--filter", "@opentradesos/db", "seed", "--pack", packId],
    { encoding: "utf8", env: { ...process.env, TZ: "America/Chicago" } },
  );
  const token = output.match(/ots_session=([^;]+);/)?.[1];
  if (!token) {
    console.log(`  FAIL  ${packId.padEnd(20)} the seed printed no session`);
    failed += 1;
    continue;
  }

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  await context.addCookies([{ name: "ots_session", value: token, url: values.base }]);
  // Expanded, so the trade shots match the rest of the set.
  await context.addCookies([{ name: "ots_rail", value: "expanded", url: values.base }]);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const response = await page.goto(`${values.base}/pricebook`, {
    waitUntil: "networkidle", timeout: 60_000,
  });
  await page.addStyleTag({ content: HIDE_DEV });

  const status = response?.status() ?? 0;
  if (status !== 200 || errors.length > 0) {
    console.log(`  FAIL  ${packId.padEnd(20)} ${status} ${errors[0] ?? ""}`);
    failed += 1;
  } else {
    await page.screenshot({ path: `${values.out}/pricebook-${packId}.png`, fullPage: true });
    console.log(`  ok    ${packId.padEnd(20)} ${status}`);
  }
  await context.close();
}

await browser.close();

if (failed > 0) {
  /**
   * The whole run fails rather than the one capture. A set of trade shots
   * with one trade quietly missing is a set somebody ships, and the gap
   * turns up as a broken image on that trade's page.
   */
  console.log(`\n  ${failed} capture(s) failed. Nothing above is publishable.\n`);
  process.exit(1);
}

console.log(`\n  ${wanted.length} trade screenshots written to ${values.out}`);
console.log("  The database now holds whichever trade ran last. `pnpm db:seed` restores the demo.\n");
