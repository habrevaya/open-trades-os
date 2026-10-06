import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { readSeed, type Seed } from "./seed";

/**
 * Who is at the keyboard.
 *
 * The seeded owner and technician sign in the way the seed tells a person to:
 * by holding the session it printed. Each gets their own browser context, so
 * a spec that needs the owner and the customer at once has two windows that
 * share nothing, which is what an office and a customer's phone are.
 *
 * Every page also fails its test on an uncaught error in the browser. A form
 * that submits and leaves a stack trace in the console has not worked, it has
 * just not been looked at.
 */
type Fixtures = {
  seed: Seed;
  owner: Page;
  tech: Page;
  /** A browser with nobody signed in, for the customer's side. */
  stranger: Page;
};

const watched = new WeakSet<Page>();

async function open(context: BrowserContext, errors: string[]): Promise<Page> {
  const page = await context.newPage();
  watch(page, errors);
  return page;
}

function watch(page: Page, errors: string[]): void {
  if (watched.has(page)) return;
  watched.add(page);
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${String(error)}`));
}

async function signedIn(
  browser: import("@playwright/test").Browser,
  baseURL: string,
  token: string,
  options: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {},
) {
  const context = await browser.newContext({ ...options, baseURL });
  await context.addCookies([{ name: "ots_session", value: token, url: baseURL }]);
  return context;
}

export const test = base.extend<Fixtures & { errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    watch(page, errors);
    await use(errors);
    expect(errors, "uncaught errors in the browser").toEqual([]);
  },
  // eslint-disable-next-line no-empty-pattern
  seed: async ({}, use) => use(readSeed()),
  owner: async ({ browser, baseURL, seed, errors }, use) => {
    const context = await signedIn(browser, baseURL!, seed.owner);
    await use(await open(context, errors));
    await context.close();
  },
  tech: [async ({ browser, baseURL, seed, errors }, use) => {
    const release = await holdTheTechnician();
    try {
      const context = await signedIn(browser, baseURL!, seed.tech, {
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      });
      await use(await open(context, errors));
      await context.close();
    } finally {
      await release();
    }
  }, { timeout: 600_000 }],
  stranger: async ({ browser, baseURL, errors }, use) => {
    const context = await browser.newContext({ baseURL });
    await use(await open(context, errors));
    await context.close();
  },
});

export { expect };

/**
 * ONE TECHNICIAN, ONE PHONE AT A TIME
 *
 * The seed has one technician, and their day is one thing on the server:
 * opening `/my-day` registers the browser as their device, which also lifts a
 * revocation, and a punch in one window is the clock in another. Specs run in
 * parallel, so a test that revokes the phone and waits to be told so could
 * have it lifted by another file opening the same day a moment later. Every
 * test that signs in as the technician holds this lock for its length, on one
 * connection inside a transaction, so those tests take turns and everything
 * else runs beside them.
 */
async function holdTheTechnician(): Promise<() => Promise<void>> {
  const db = createClient();
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const held = new Promise<void>((resolve) => { locked = resolve; });
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7101002)`);
    locked();
    await finished;
  });
  await Promise.race([held, done]);
  return async () => {
    release();
    await done;
    await db.$close();
  };
}

/** A suffix that makes this run's rows distinguishable from the last run's. */
export const run = Date.now().toString(36);

/**
 * A customer, through the New customer form, as the office adds one while
 * the phone is ringing. Answers the id off the page it lands on.
 */
export async function newCustomer(owner: Page, customer: {
  name: string; phone?: string; email?: string;
  address?: { street: string; city: string; state: string; zip: string };
}): Promise<string> {
  await owner.goto("/customers/new");
  await owner.getByLabel("Name").fill(customer.name);
  if (customer.phone) await owner.getByLabel("Phone").fill(customer.phone);
  if (customer.email) await owner.getByLabel("Email").fill(customer.email);
  if (customer.address) {
    await owner.getByLabel("Street").fill(customer.address.street);
    await owner.getByLabel("City").fill(customer.address.city);
    await owner.getByLabel("State").fill(customer.address.state);
    await owner.getByLabel("ZIP").fill(customer.address.zip);
  }
  await owner.getByRole("button", { name: "Save customer" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: customer.name })).toBeVisible();
  return owner.url().split("/").pop()!;
}

/**
 * A date as the seeded company counts days (America/Chicago, the default).
 * UTC's date is the company's tomorrow for the hours after midnight UTC, and
 * a spec that asks for "today" by it then finds nothing that happened today.
 */
export function companyToday(timeZone = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}
