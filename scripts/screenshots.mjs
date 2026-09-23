#!/usr/bin/env node
/**
 * PRODUCT SCREENSHOTS
 *
 * Captures the running application against the seeded demo company.
 *
 * This exists so that every screenshot on the website is reproducible. A
 * marketing screenshot nobody can regenerate is a promise nobody is checking,
 * and this project's whole argument is that you can check everything.
 *
 * Usage:
 *
 *   TZ=America/Chicago pnpm db:seed
 *   TZ=America/Chicago pnpm --filter @opentradesos/web dev
 *   node scripts/screenshots.mjs --seed-output /tmp/seed.txt --out ./shots
 *
 * The TZ matters and is not a detail. The seed builds the day around the
 * current hour and the app renders every time in the company's timezone, so
 * running both in the company's own zone is what produces a day that looks
 * like a working day rather than one that starts at half past six in the
 * evening.
 *
 * The script FAILS on a non-200 or an uncaught page error rather than saving
 * a screenshot of an error page, because a broken screenshot that still gets
 * written is one somebody ships.
 */
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "seed-output": { type: "string" },
    out: { type: "string", default: "./shots" },
    base: { type: "string", default: "http://localhost:3000" },
    browser: { type: "string", default: process.env["CHROMIUM_PATH"] ?? "" },
  },
});

if (!values["seed-output"]) {
  console.error(
    "\n  Pass --seed-output, the file you captured `pnpm db:seed` into.\n" +
      "  The tokens and portal links are read from it, so the capture uses the\n" +
      "  same company the seed just built rather than a stale session.\n",
  );
  process.exit(1);
}

const seed = readFileSync(values["seed-output"], "utf8");
const sessions = [...seed.matchAll(/ots_session=([^;]+);/g)].map((m) => m[1]);
const links = Object.fromEntries(
  [...seed.matchAll(/(proposal|job tracking)\s+(\/\S+)/g)].map((m) => [m[1], m[2]]),
);

const [OWNER, TECH] = sessions;
if (!OWNER || !TECH || !links["proposal"] || !links["job tracking"]) {
  console.error("\n  That seed output has no sessions or portal links in it.\n");
  process.exit(1);
}

const PHONE = { width: 414, height: 850, mobile: true };
// 760 rather than 900: the board fills the top of the viewport, and the extra
// height captured 300 pixels of empty columns that render as dead space.
const DESK = { width: 1440, height: 760 };

const SHOTS = [
  { name: "dispatch-board", path: "/schedule", token: OWNER, ...DESK },
  { name: "my-day", path: "/my-day", token: TECH, ...PHONE },
  {
    name: "visit-detail", path: "/my-day", token: TECH, ...PHONE,
    click: "article:nth-of-type(1) button",
  },
  {
    name: "proposal", path: links["proposal"], ...DESK, height: 1000,
    // Selected, so the capture shows the line items and the signature field
    // rather than three collapsed prices. The decision is the screen.
    click: "div:has(> button) > button",
  },
  { name: "proposal-phone", path: links["proposal"], ...PHONE },
  { name: "job-tracking", path: links["job tracking"], ...PHONE },
  /**
   * The back office screens, each cropped to roughly what its own content
   * fills.
   *
   * A list is read from the top, and a fixed tall viewport over a five row
   * table captures three hundred pixels of nothing, which reads as a product
   * with no data in it rather than as a crop. The demo company is a small
   * shop on purpose, so the heights are per screen rather than shared.
   */
  { name: "customers", path: "/customers", token: OWNER, ...DESK, height: 520 },
  { name: "jobs", path: "/jobs", token: OWNER, ...DESK, height: 600 },
  { name: "invoices", path: "/invoices", token: OWNER, ...DESK, height: 520 },
  {
    // As the owner, so the cost column is in the capture. It is the column a
    // technician does not get, and a screenshot without it cannot show that.
    name: "price-book", path: "/pricebook", token: OWNER, ...DESK, height: 760,
  },
  /**
   * Settings as the owner, because it is the screen that shows the state of
   * the things a reader is most likely to disbelieve: whether a number is
   * cleared to send, whether an automation is on, and who holds which role.
   */
  { name: "settings", path: "/settings", token: OWNER, ...DESK, height: 900 },
];

/** The dev overlay is not part of the product. */
const HIDE_DEV = `nextjs-portal, #__next-build-watcher, [data-nextjs-toast] { display: none !important; }`;

mkdirSync(values.out, { recursive: true });

const browser = await chromium.launch(
  values.browser ? { executablePath: values.browser } : {},
);

let failed = 0;
for (const shot of SHOTS) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    // Retina, so the images hold up on the displays people read marketing on.
    deviceScaleFactor: 2,
    isMobile: shot.mobile ?? false,
    hasTouch: shot.mobile ?? false,
  });
  if (shot.token) {
    await context.addCookies([{ name: "ots_session", value: shot.token, url: values.base }]);
  }

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const response = await page.goto(`${values.base}${shot.path}`, {
    waitUntil: "networkidle", timeout: 60_000,
  });
  await page.addStyleTag({ content: HIDE_DEV });
  if (shot.click) {
    await page.click(shot.click).catch(() => errors.push(`could not click ${shot.click}`));
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${values.out}/${shot.name}.png` });

  /**
   * The status alone is not enough, and the gap is the one that matters.
   *
   * A stale session redirects to sign in, and the sign in page answers 200.
   * Checking only the status captured a screenshot of a login form and called
   * it the dispatch board. So the final URL has to be the one that was asked
   * for: a redirect anywhere is a failed capture.
   */
  const status = response?.status() ?? 0;
  const landed = new URL(page.url()).pathname;
  const wanted = new URL(shot.path, values.base).pathname;
  const redirected = landed !== wanted;
  const ok = status === 200 && errors.length === 0 && !redirected;

  if (!ok) failed += 1;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${shot.name.padEnd(16)} ${status}` +
      (redirected ? `  redirected to ${landed}` : "") +
      (errors.length ? `  ${errors[0]}` : ""),
  );
  await context.close();
}

await browser.close();

if (failed > 0) {
  console.error(`\n  ${failed} capture(s) failed. Nothing above is publishable.\n`);
  process.exit(1);
}
console.log(`\n  ${SHOTS.length} screenshots written to ${values.out}\n`);
