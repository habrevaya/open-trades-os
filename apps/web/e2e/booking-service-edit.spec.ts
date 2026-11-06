import type { Page } from "@playwright/test";
import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";
import { test, expect, run } from "./fixtures";

/**
 * CHANGING A SERVICE THE PUBLIC MAY BOOK
 *
 * A job type of this run's own is offered through the API (offering one is
 * not what is tested), then changed on Online booking: a new name and price,
 * a deposit as a percent, refused in words when the figure is missing, and
 * taken off the booking page and put back. The public page is read to see it
 * go and come back.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the office changes a service's terms, its deposit, and takes it off the booking page and back", async ({ owner, stranger }) => {
  const name = `Duct clean ${run}`;
  const db = createClient();
  let jobTypeId: string;
  try {
    const [row] = await db.execute<{ id: string }>(sql`insert into public.job_type (organization_id, name)
      select id, ${name} from public.organization where slug = 'ridgeline' returning id`);
    jobTypeId = row!.id;
  } finally {
    await db.$close();
  }
  const offered = await api<{ id: string }>(owner, "post", "/v1/booking/services", {
    jobTypeId, publicName: name, minNoticeHours: 24, maxAdvanceDays: 60, maxPerWindow: 2,
  });

  await owner.goto("/booking");
  const edit = owner.getByTestId("edit-service").filter({ hasText: `Edit ${name}` });
  await edit.getByText(`Edit ${name}`).click();
  await edit.getByLabel("What customers see it called").fill(`${name}, whole house`);
  await edit.getByLabel("Price shown", { exact: true }).fill("249.00");
  await edit.getByLabel("Notice (hours)").fill("48");
  await expect(edit).toContainText("The booking page does not take money.");

  await edit.getByLabel("A percent of the price shown").check();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit.getByRole("alert")).toHaveText("Say what percent to ask for, or choose no deposit.");

  await edit.getByLabel("Deposit amount or percent").fill("10");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit.getByRole("status")).toHaveText("Saved. It is on the booking page.");

  const row = owner.getByRole("row").filter({ hasText: `${name}, whole house` });
  await expect(row).toContainText("$249.00");
  await expect(row).toContainText("Yes");

  await stranger.goto("/book/ridgeline");
  await expect(stranger.getByText(`${name}, whole house`)).toBeVisible();

  await owner.reload();
  const again = owner.getByTestId("edit-service").filter({ hasText: `Edit ${name}, whole house` });
  await again.getByText(`Edit ${name}, whole house`).click();
  await expect(again.getByLabel("Deposit amount or percent")).toHaveValue("10");
  await expect(again.getByLabel("Notice (hours)")).toHaveValue("48");
  await again.getByLabel("On the booking page").uncheck();
  await again.getByRole("button", { name: "Save changes" }).click();
  await expect(again.getByRole("status")).toHaveText("Saved. It is off the booking page.");
  await expect(owner.getByRole("row").filter({ hasText: `${name}, whole house` })).toContainText("No");

  await stranger.reload();
  await expect(stranger.getByText(`${name}, whole house`)).toHaveCount(0);

  const services = await api<{ services: { id: string; publicName: string; depositPercent: string | null }[] }>(
    owner, "get", "/v1/public/services?organizationSlug=ridgeline");
  expect(services.services.find((s) => s.publicName === `${name}, whole house`)).toBeUndefined();

  await again.getByLabel("On the booking page").check();
  await again.getByRole("button", { name: "Save changes" }).click();
  await expect(again.getByRole("status")).toHaveText("Saved. It is on the booking page.");
  const back = await api<{ services: { publicName: string; depositPercent: string | null }[] }>(
    owner, "get", "/v1/public/services?organizationSlug=ridgeline");
  /**
   * The terms are kept, and the public list carries them only once the
   * company shows deposits on the booking page, which Ridgeline has not.
   */
  expect(back.services.find((s) => s.publicName === `${name}, whole house`)?.depositPercent).toBeNull();

  /** Off again, so the next spec's booking page is the one it expects. */
  const off = await owner.request.put(`/api/v1/booking/services/${offered.id}`, {
    data: { publicName: name, minNoticeHours: 24, maxAdvanceDays: 60, maxPerWindow: 2, isActive: false },
  });
  expect(off.ok()).toBe(true);
});
