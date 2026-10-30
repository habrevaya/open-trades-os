import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

/**
 * A PRICING RULE FOR THE NIGHT, REGISTERED AS ONE WINDOW
 *
 * An application registers "from 18:00 to 06:00, starting Monday and Tuesday"
 * with its own credential and nothing else. It used to be refused ("register
 * two rules"); it is one rule now, and the company reads it back under the
 * application in a sentence that says the window starts on those days and ends
 * the next one. A window that starts and ends at the same minute is refused in
 * words, and nothing is registered.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("an application registers a night window as one rule and the company reads it back", async ({ owner, stranger }) => {
  const app = await api<{ app: string }>(owner, "post", "/v1/apps", {
    name: `Night Pricer ${run}`, publisher: "Night Ltd",
    permissions: ["pricebook:write", "visit:read"],
    scopes: { visit: "all" },
  });
  const { token } = await api<{ token: string }>(owner, "post", `/v1/apps/${app.app}/tokens`, { label: "e2e" });
  const asApp = (request: APIRequestContext, data: unknown) =>
    request.post("/api/v1/plugins/pricing-rules", { data, headers: { authorization: `Bearer ${token}` } });

  // The same minute at both ends is not a window.
  const same = await asApp(stranger.request, {
    key: "same", name: "Same minute", rule: { kind: "time_window", window: { days: [1], from: "06:00", to: "06:00" }, percent: "10" },
  });
  expect(same.ok()).toBe(false);
  expect(await same.text()).toContain("start and end at different times");

  // From 18:00 to 06:00 is one rule.
  const night = await asApp(stranger.request, {
    key: "night", name: "Night call", rule: { kind: "time_window", window: { days: [2, 1], from: "18:00", to: "06:00" }, percent: "50" },
  });
  expect(night.ok(), await night.text()).toBe(true);

  await owner.goto("/settings/apps");
  const listed = owner.getByRole("table", { name: `What Night Pricer ${run} added` });
  await expect(listed).toContainText("Night call");
  await expect(listed).toContainText("50% added for work from 18:00 on Mon, Tue until 06:00 the next day");
  await expect(listed).not.toContainText("Same minute");
});
