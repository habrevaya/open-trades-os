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
 *   timeout 10 pnpm --filter @opentradesos/api worker
 *   TZ=America/Chicago pnpm --filter @opentradesos/web dev
 *   node scripts/screenshots.mjs --seed-output /tmp/seed.txt --out ./shots
 *
 * The worker pass is not optional if the automations screen is in the run.
 * The seed writes the events a completed job produces and nothing else reads
 * them, so without it the run log is empty and the screen shows two
 * automations that have never done anything.
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
  /**
   * The inbox, and one thread inside it. Two shots because the list answers
   * "which of these needs me" and the thread answers "and what do I say",
   * which are different screens doing different jobs.
   */
  { name: "inbox", path: "/inbox", token: OWNER, ...DESK, height: 380 },
  { name: "tasks", path: "/tasks", token: OWNER, ...DESK, height: 620 },
  /**
   * Reporting, in three shots, because the claim being made is three claims.
   *
   * The list shows that there are answers in the box. A built-in report shows
   * what one of them looks like. The builder shows that the custom side is a
   * real screen and not a roadmap item, which is the one a reader is most
   * likely to disbelieve.
   */
  /**
   * The agreement book, and one member.
   *
   * The list shot is the three numbers an owner opens it for; the detail is
   * the two schedules side by side, which is the claim that would otherwise
   * be a sentence nobody can check.
   */
  /**
   * A job, including the three decisions that stop an invoice: who is
   * involved, who is paying, and what they authorised. All three are made
   * before anybody invoices and usually by somebody else, so the job says so.
   *
   * Deliberately the Suite 400 job rather than the first row. It is the one
   * seeded job with a cast: a managing agent who asked for it and receives
   * the invoice, a tenant on site who is not a customer of ours, and a
   * ceiling with an invoice already against it. Every other job in the demo
   * is residential, and a shot of one of those shows the empty state of the
   * feature this screen exists to show.
   */
  {
    name: "job", path: "/jobs", token: OWNER, ...DESK, height: 1400,
    click: 'main table tbody tr:has-text("Suite 400") a',
    lands: "/jobs/",
  },
  { name: "agreements", path: "/agreements", token: OWNER, ...DESK, height: 900 },
  {
    name: "agreement", path: "/agreements", token: OWNER, ...DESK, height: 1100,
    click: "main table tbody tr:first-child a",
    lands: "/agreements/",
  },
  /**
   * The two dashboards. Both, because the interesting claim is that they are
   * the same machinery: every tile on them is a report definition run through
   * the same resolver, so a dashboard cannot disagree with the report behind
   * it about what a number means.
   */
  { name: "dashboard-operations", path: "/dashboards/operations", token: OWNER, ...DESK, height: 1000 },
  { name: "dashboard-money", path: "/dashboards/money", token: OWNER, ...DESK, height: 1000 },
  /*
    The same board with the rail collapsed. Two captures of one screen is
    worth it here: the claim is that the icons keep their order, so the
    thing worth showing is the pair rather than either one.
  */
  {
    name: "dispatch-board-collapsed", path: "/schedule", token: OWNER, ...DESK,
    height: 1520, rail: "collapsed",
  },
  { name: "reports", path: "/reports", token: OWNER, ...DESK, height: 760 },
  {
    name: "report-receivables", path: "/reports/built-in/ar-aging",
    // Tall enough for the whole sidebar, so the capture shows where in the
    // product this screen is rather than cropping the section it belongs to.
    token: OWNER, ...DESK, height: 760,
  },
  /**
   * The automations screen, and one automation's run log.
   *
   * The log is the reason for the second shot. "Why did this customer get
   * that text" is what somebody opens this screen to answer, and a list of
   * workflow names answers it no better than not having the screen.
   */
  { name: "automations", path: "/automations", token: OWNER, ...DESK, height: 760 },
  {
    name: "automation-runs", path: "/automations", token: OWNER, ...DESK, height: 900,
    // The second one, deliberately: it is the one that has actually run, and
    // the run log is the whole reason for this capture.
    click: "main ul li:nth-of-type(2) a",
    lands: "/automations/",
  },
  {
    name: "report-builder",
    path: "/reports/new?dataset=invoices&dimensions=month&measures=total,count,average",
    token: OWNER, ...DESK, height: 1000,
  },
  {
    name: "inbox-thread", path: "/inbox", token: OWNER, ...DESK, height: 640,
    /**
     * Scoped to `main`, because the navigation moved into a sidebar and the
     * sidebar is a list of links too. A bare `ul li:first-child a` started
     * clicking "My day" instead of the first thread, and the capture landed
     * on the dispatch board with a 200 and the wrong screen in it.
     */
    click: "main ul li:first-child a",
    // The click opens a thread, whose id comes from the seed. A prefix, so a
    // redirect to sign in still fails the capture.
    lands: "/inbox/",
  },
];

/**
 * The dev overlay is not part of the product.
 *
 * The selector list grows with the framework: Next renamed the badge and the
 * old rule stopped matching, so a small dark circle sat in the corner of
 * every capture until somebody looked at one. Anything whose name starts
 * `nextjs-` is the toolchain rather than the application.
 */
const HIDE_DEV = `
  nextjs-portal,
  [id^="__next"],
  [data-nextjs-toast],
  [data-nextjs-dev-tools-button],
  [data-next-badge-root],
  [class*="dev-tools-indicator"] { display: none !important; }
`;

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
  /*
    The collapsed rail is a cookie, because this application navigates with
    full document loads and component state would reset on every click. Set
    directly here rather than clicked: the button posts to a server action
    and redirects, and a capture that depends on a round trip completing is
    a capture that is flaky before it is anything else.
  */
  if (shot.rail) {
    await context.addCookies([{ name: "ots_rail", value: shot.rail, url: values.base }]);
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
    /**
     * Again, because the links in this app are plain anchors rather than
     * router links, so a click is a full document load and the style tag
     * went with the old document. One capture came back with the dev tools
     * badge sitting over the sign out button.
     */
    await page.addStyleTag({ content: HIDE_DEV });
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
   *
   * A shot whose click is MEANT to navigate says where to, as a prefix, and
   * the check holds against that instead. Loosening it to "any URL is fine
   * once you clicked" would have given the guard away on exactly the shots
   * that click into a detail screen, which is where a stale link or a
   * redirect to sign in is most likely.
   */
  const status = response?.status() ?? 0;
  const landed = new URL(page.url()).pathname;
  const wanted = shot.lands ?? new URL(shot.path, values.base).pathname;
  const redirected = shot.lands ? !landed.startsWith(shot.lands) : landed !== wanted;
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
