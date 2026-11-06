import type { Page } from "@playwright/test";
import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";
import { test, expect, run } from "./fixtures";

/**
 * THE BOOKING PAGE TELLS PEOPLE ABOUT A DEPOSIT, IF THE BUSINESS WANTS IT TO
 *
 * A service of this run's own, $200 with a 25 per cent deposit, is offered
 * through the API. With the company's choice off the booking page says
 * nothing about it. The office turns on "Show deposits on the booking page"
 * on Online booking; the public page then says the deposit before the
 * customer books, the customer books, and the confirmation and the tracking
 * link say it again. Everything is put back at the end.
 */
async function api<T>(page: Page, method: "get" | "post" | "put", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

const SUMMARY = "This service needs a deposit of $50.00, which is 25% of $200.00.";
const NEXT = "You pay nothing on this page. After we confirm your booking, we will ask you for the deposit.";

test("the office shows deposits on the booking page, and the customer reads it before and after booking", async ({ owner, stranger }) => {
  const name = `Panel check ${run}`;
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
    jobTypeId, publicName: name, displayPrice: "200.00", depositPercent: "0.25",
    minNoticeHours: 24, maxAdvanceDays: 60, maxPerWindow: 2,
  });

  try {
    /** Off, as every company starts: nothing about deposits on the page. */
    expect(await api<{ showDeposits: boolean }>(owner, "get", "/v1/booking/page-settings")).toEqual({ showDeposits: false });
    await stranger.goto("/book/ridgeline");
    await stranger.getByRole("button", { name: new RegExp(name) }).click();
    await expect(stranger.locator("p.uppercase").first()).toBeVisible();
    await expect(stranger.getByText(/deposit/i)).toHaveCount(0);

    /** The office turns it on, where it edits services. */
    await owner.goto("/booking");
    const edit = owner.getByTestId("edit-service").filter({ hasText: `Edit ${name}` });
    await edit.getByText(`Edit ${name}`).click();
    await expect(edit.getByTestId("deposit-note")).toContainText("The booking page does not take money. It does not show this deposit either.");
    const choice = owner.getByRole("form", { name: "Deposits on the booking page" });
    await choice.getByLabel("Show deposits on the booking page").check();
    await choice.getByRole("button", { name: "Save" }).click();
    await expect(choice.getByRole("status")).toHaveText("Saved.");
    await owner.reload();
    await owner.getByTestId("edit-service").filter({ hasText: `Edit ${name}` }).getByText(`Edit ${name}`).click();
    await expect(owner.getByTestId("edit-service").filter({ hasText: `Edit ${name}` }).getByTestId("deposit-note"))
      .toContainText("The booking page does not take money. It shows this deposit to the customer before they book");
    await expect(owner.getByLabel("Show deposits on the booking page")).toBeChecked();

    /** The customer reads it on the service, and again before they press Book it. */
    await stranger.reload();
    const card = stranger.getByRole("button", { name: new RegExp(name) });
    await expect(card.getByTestId("deposit-on-service")).toHaveText(SUMMARY);
    await card.click();
    await stranger.locator("p.uppercase").first().waitFor();
    await stranger.locator("button.h-12").first().click();
    const before = stranger.getByTestId("deposit-before-booking");
    await expect(before).toContainText(SUMMARY);
    await expect(before).toContainText(NEXT);

    const contact = `Dee Positor ${run}`;
    await stranger.getByLabel("Your name").fill(contact);
    await stranger.getByLabel("Phone").fill("5125550199");
    await stranger.getByLabel("Address").fill("12 Oak Hollow");
    await stranger.getByLabel("City").fill("Austin");
    await stranger.getByLabel("State").fill("TX");
    await stranger.getByLabel("ZIP").fill("78704");
    await stranger.getByRole("button", { name: "Book it" }).click();

    /** And again on the confirmation, and on the page the tracking link opens. */
    await expect(stranger.getByText("You are booked.")).toBeVisible();
    const booked = stranger.getByTestId("deposit-booked");
    await expect(booked).toContainText(SUMMARY);
    await expect(booked).toContainText(NEXT);
    const tracking = await stranger.getByRole("link", { name: /\/b\// }).getAttribute("href");
    await stranger.goto(new URL(tracking!).pathname);
    await expect(stranger.getByText("We have your request.")).toBeVisible();
    await expect(stranger.getByTestId("deposit-tracking")).toContainText(SUMMARY);

    /** The request is declined so it holds no room in anybody's window. */
    const lookup = createClient();
    let requestId: string | undefined;
    try {
      const [row] = await lookup.execute<{ id: string }>(sql`select id from public.booking_request
        where contact_name = ${contact} and status = 'pending'`);
      requestId = row?.id;
    } finally {
      await lookup.$close();
    }
    expect(requestId, "the booking reached the office's queue").toBeTruthy();
    await api(owner, "post", `/v1/bookings/${requestId}/decline`, { reason: "other", notifyCustomer: false });
  } finally {
    /** Back off, so the next spec's booking page is the one it expects. */
    await api(owner, "put", "/v1/booking/page-settings", { showDeposits: false });
    await api(owner, "put", `/v1/booking/services/${offered.id}`, {
      publicName: name, minNoticeHours: 24, maxAdvanceDays: 60, maxPerWindow: 2, isActive: false,
    });
  }
});
