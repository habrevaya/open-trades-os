import { test, expect, run, newCustomer } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * THE DISPATCH MAP, THE ROUTE OPTIMISER AND THE SKILL CHECK, IN A BROWSER
 *
 * One day, four days out so nothing in it has already happened: a pin
 * placed by hand on a property page, a yard placed on the technicians
 * screen, a visit the geocoder never placed listed beside the map rather
 * than dropped, an unqualified technician refused from the map's card and
 * then sent anyway with a reason, a technician's zig zag day put in order
 * by the optimiser, and an unassigned visit handed to the one person
 * recorded as able to do it.
 *
 * NO TILE LEAVES THE MACHINE. Every request for an OpenStreetMap tile is
 * answered here with a blank square: the public tile servers ask not to be
 * load tested, and a suite that fetched real tiles would pass or fail on
 * somebody else's network.
 */

const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const ZONE = "America/Chicago";
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() + 4 * 864e5));
/** A wall clock time on DAY in Austin, as an instant. Central daylight time in October is five hours behind. */
const at = (hour: number, minute = 0) => {
  const local = new Date(`${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "shortOffset" })
    .formatToParts(local).find((p) => p.type === "timeZoneName")!.value; // e.g. "GMT-5"
  const hours = Number(offset.replace("GMT", "") || "0");
  return new Date(local.getTime() - hours * 3_600_000).toISOString();
};

async function api<T>(page: Page, method: "get" | "post" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function propertyOf(page: Page, customerId: string): Promise<string> {
  const page1 = await api<{ data: { id: string }[] }>(page, "get", `/v1/properties?customerId=${customerId}`);
  return page1.data[0]!.id;
}

async function book(page: Page, input: {
  customerId: string; propertyId: string; summary: string; jobTypeId?: string;
  from: string; to: string; technicianIds?: string[];
}): Promise<{ id: string; number: number }> {
  return api(page, "post", "/v1/jobs", {
    customerId: input.customerId, propertyId: input.propertyId, summary: input.summary,
    ...(input.jobTypeId ? { jobTypeId: input.jobTypeId } : {}),
    visit: {
      windowStart: input.from, windowEnd: input.to, estimatedDurationMinutes: 30,
      technicianIds: input.technicianIds ?? [],
    },
  });
}

test("Dispatch map: pins, a refused technician sent with a reason, a day put in order, and a suggestion taken", async ({ owner }) => {
  test.setTimeout(180_000);
  await owner.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG }));

  const { technicians } = await api<{ technicians: { id: string; displayName: string; skills: string[] }[] }>(
    owner, "get", "/v1/technicians");
  const nia = technicians.find((t) => t.displayName === "Nia Osei")!;
  const niaSkills = nia.skills;
  const types = await api<{ data: { id: string; name: string }[] }>(owner, "get", "/v1/job-types");
  const install = types.data.find((t) => t.name === "System replacement")!;

  try {
    /**
     * The technicians screen. Recording Nia as doing installs is what starts
     * refusing everybody who is not recorded with it.
     */
    await owner.goto("/schedule/technicians");
    await expect(owner.getByRole("heading", { level: 1, name: "Technicians" })).toBeVisible();
    const niaRow = owner.getByRole("table", { name: "Technicians" }).getByRole("row").filter({ hasText: "Nia Osei" });
    await niaRow.getByLabel("Skills for Nia Osei").fill([...niaSkills, "hvac-install"].join(", "));
    await niaRow.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await api<{ technicians: { id: string; skills: string[] }[] }>(
      owner, "get", "/v1/technicians")).technicians.find((t) => t.id === nia.id)!.skills).toContain("hvac-install");
    await owner.reload();
    await expect(owner.getByLabel("Skills for Nia Osei")).toHaveValue(/hvac-install/);

    // The yard, placed by hand, which is where everybody's day starts.
    const shop = owner.locator('li[aria-label="Location Shop"]');
    await shop.getByLabel("Latitude").fill("30.330000");
    await shop.getByLabel("Longitude").fill("-97.720000");
    await shop.getByRole("button", { name: "Save pin" }).click();
    await expect(shop.getByText("Placed by hand")).toBeVisible();

    // A property placed by hand from its own page.
    const install1 = await newCustomer(owner, {
      name: `Map install ${run}`,
      address: { street: `${run.slice(-4)} Map Ln`, city: "Austin", state: "TX", zip: "78745" },
    });
    const install1Property = await propertyOf(owner, install1);
    await owner.goto(`/properties/${install1Property}#pin`);
    const where = owner.getByRole("region", { name: "Where it is" });
    await where.getByLabel("Latitude").fill("30.300000");
    await where.getByLabel("Longitude").fill("-97.750000");
    await where.getByRole("button", { name: "Save pin" }).click();
    await expect(where.getByText("Placed by hand. The geocoder will not move it.")).toBeVisible();

    // One the geocoder never placed, and three along a road for Nia, booked out of order.
    const lost = await newCustomer(owner, {
      name: `Map unplaced ${run}`,
      address: { street: `${run.slice(-4)} Lost Rd`, city: "Austin", state: "TX", zip: "78745" },
    });
    const lostProperty = await propertyOf(owner, lost);
    const stops: { name: string; lng: number; from: string }[] = [
      { name: `Map far ${run}`, lng: -97.66, from: at(8, 0) },
      { name: `Map near ${run}`, lng: -97.70, from: at(8, 5) },
      { name: `Map mid ${run}`, lng: -97.68, from: at(8, 10) },
    ];
    for (const s of stops) {
      const customer = await newCustomer(owner, {
        name: s.name, address: { street: `${run.slice(-4)} ${s.name.split(" ")[1]} St`, city: "Austin", state: "TX", zip: "78723" },
      });
      const property = await propertyOf(owner, customer);
      await api(owner, "post", `/v1/properties/${property}/pin`, { latitude: 30.33, longitude: s.lng });
      await book(owner, {
        customerId: customer, propertyId: property, summary: `Tune up ${s.name}`,
        from: s.from, to: at(17), technicianIds: [nia.id],
      });
    }
    const installJob = await book(owner, {
      customerId: install1, propertyId: install1Property, summary: "Replace the condenser",
      jobTypeId: install.id, from: at(9), to: at(17),
    });
    await book(owner, {
      customerId: lost, propertyId: lostProperty, summary: "Nobody knows where this is", from: at(9), to: at(17),
    });
    const second = await newCustomer(owner, {
      name: `Map second install ${run}`,
      address: { street: `${run.slice(-4)} Second Ln`, city: "Austin", state: "TX", zip: "78723" },
    });
    const secondProperty = await propertyOf(owner, second);
    await api(owner, "post", `/v1/properties/${secondProperty}/pin`, { latitude: 30.335, longitude: -97.69 });
    await book(owner, {
      customerId: second, propertyId: secondProperty, summary: "Second condenser",
      jobTypeId: install.id, from: at(9), to: at(17),
    });

    /**
     * The map. The visit with no coordinates is listed beside it with a way
     * to place it, never silently missing.
     */
    await owner.goto(`/schedule?date=${DAY}&view=map`);
    await expect(owner.getByRole("region", { name: "Dispatch map" })).toBeVisible();
    const unplaced = owner.getByRole("region", { name: "Not on the map yet" });
    await expect(unplaced).toContainText(`Map unplaced ${run}`);
    await expect(unplaced.getByRole("link", { name: "Place a pin" }).first())
      .toHaveAttribute("href", new RegExp(`/properties/${lostProperty}#pin`));
    await expect(owner.getByText("© OpenStreetMap contributors")).toBeVisible();

    // Clicking the unassigned install opens its card, and Sam is refused for it.
    await owner.getByRole("button", { name: new RegExp(`#${installJob.number}, Map install ${run}, unassigned`) }).click();
    const card = owner.getByRole("article", { name: "Visit on the map" });
    await expect(card).toContainText(`Map install ${run}`);
    await card.getByLabel("Put on the day of").selectOption({ label: "Sam Reyes" });
    await card.getByRole("button", { name: "Assign" }).click();
    const refusal = owner.getByRole("form", { name: "Not qualified" });
    await expect(refusal).toContainText("Sam Reyes cannot be sent: this work needs hvac-install.");

    // The owner may send him anyway, with a reason the audit log keeps.
    await refusal.getByLabel("Why they are going anyway").fill("Nia is on the other side of town, Sam has done these with her");
    await refusal.getByRole("button", { name: "Send anyway" }).click();
    await expect(refusal).toHaveCount(0);
    await expect(owner.getByRole("button", { name: new RegExp(`#${installJob.number}, Map install ${run}, Sam Reyes`) }))
      .toBeVisible();

    /**
     * The board. Nia's day was booked far, near, mid; the optimiser proposes
     * driving along the road in order and says how much driving it saves, and
     * nothing moves until the button is pressed.
     */
    await owner.goto(`/schedule?date=${DAY}`);
    await owner.getByRole("button", { name: "Optimise route for Nia Osei" }).click();
    const preview = owner.getByRole("dialog", { name: "Proposed order for Nia Osei" });
    await expect(preview).toContainText("min driving now");
    await expect(preview).toContainText("min less");
    /**
     * Along the road and back, in one direction or the other: out and back
     * along a line is the same drive either way, so the middle stop is what
     * says the zig zag is gone.
     */
    const order = preview.getByRole("list", { name: "The order" });
    await expect(order.getByRole("listitem").nth(1)).toContainText(`Map mid ${run}`);
    await preview.getByRole("button", { name: "Use this order" }).click();
    await expect(preview).toHaveCount(0);

    // Asked again, the day is already in the best order this can find.
    await owner.getByRole("button", { name: "Optimise route for Nia Osei" }).click();
    await expect(owner.getByRole("dialog", { name: "Proposed order for Nia Osei" })).toContainText("already the best");
    await owner.getByRole("button", { name: "Close" }).click();

    /**
     * Who should take the second install: Nia, the only person recorded as
     * doing them, with everybody else's reason a click away.
     */
    await owner.getByRole("button", { name: "Suggest who" }).click();
    const suggestions = owner.getByRole("region", { name: "Suggestions" });
    const item = suggestions.getByRole("listitem").filter({ hasText: `Map second install ${run}` }).first();
    await expect(item).toContainText("Nia Osei");
    await expect(suggestions).toContainText(`Map unplaced ${run}`);
    await item.getByRole("button", { name: "Assign to Nia Osei" }).click();
    await expect(suggestions.getByRole("listitem").filter({ hasText: `Map second install ${run}` })).toHaveCount(0);
  } finally {
    // Put Nia back as the seed had her, so no later spec meets a skill it did not set.
    await api(owner, "patch", `/v1/technicians/${nia.id}`, { skills: niaSkills });
  }
});
