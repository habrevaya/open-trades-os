import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
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
  tech: async ({ browser, baseURL, seed, errors }, use) => {
    const context = await signedIn(browser, baseURL!, seed.tech, {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    await use(await open(context, errors));
    await context.close();
  },
  stranger: async ({ browser, baseURL, errors }, use) => {
    const context = await browser.newContext({ baseURL });
    await use(await open(context, errors));
    await context.close();
  },
});

export { expect };

/** A suffix that makes this run's rows distinguishable from the last run's. */
export const run = Date.now().toString(36);

/**
 * The HTTP API, as the signed in person.
 *
 * Used only where the product has no screen for the step yet (booking a job,
 * raising an invoice, recording a payment). The request carries the same
 * session cookie as the page, so it is the same person with the same
 * permissions doing it, and the screens are then checked for the result.
 */
export async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await request.fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": `e2e-${run}-${Math.random()}` },
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await response.text();
  if (!response.ok()) throw new Error(`${method} ${path} answered ${response.status()}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}
