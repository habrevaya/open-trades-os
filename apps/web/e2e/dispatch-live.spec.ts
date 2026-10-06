import { test, expect, run, newCustomer } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * ON MY WAY WITH A MOVING PIN, AND THE DAY REBALANCED, IN A BROWSER
 *
 * Two journeys. A technician tells a customer they are on the way and the
 * customer's link shows their first name, how long they are, and a pin
 * where the van is, until the technician arrives and the pin is gone. And a
 * dispatcher asks for the whole day to be rebalanced, sees each day before
 * and after with the driving saved, and applies it.
 *
 * The technician's phone is played by its API, as the phone app calls it:
 * register, sync the tap, send the text, sync a position. Every map tile is
 * answered here with a blank square, as the dispatch map spec does.
 */

const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const ZONE = "America/Chicago";
const dayOut = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() + days * 864e5));
/** A wall clock time on a day in Austin, as an instant. */
const at = (day: string, hour: number) => {
  const local = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "shortOffset" })
    .formatToParts(local).find((p) => p.type === "timeZoneName")!.value;
  return new Date(local.getTime() - Number(offset.replace("GMT", "") || "0") * 3_600_000).toISOString();
};

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

const propertyOf = async (page: Page, customerId: string) =>
  (await api<{ data: { id: string }[] }>(page, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;

const blankTiles = (page: Page) => page.route("https://tile.openstreetmap.org/**", (route) =>
  route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG }));

test("On my way: the customer's link shows the technician coming, and stops showing them once they arrive", async ({ owner, tech, stranger }) => {
  test.setTimeout(150_000);
  await blankTiles(stranger);

  /** The owner turns live location on, on the technicians screen, where the rule is written out. */
  await owner.goto("/schedule/technicians");
  const sharing = owner.getByRole("region", { name: "Live location" });
  await expect(sharing).toContainText("Never off the clock");
  await sharing.getByLabel("Share technicians' locations").selectOption("on");
  await sharing.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await api<{ enabled: boolean }>(owner, "get", "/v1/dispatch/location-sharing")).enabled).toBe(true);

  /** A customer who has agreed to texts, at a house on the map, booked with Ray for now. */
  const phone = `+1512555${String(Date.now()).slice(-4)}`;
  const customerId = await newCustomer(owner, {
    name: `Tracked ${run}`, phone,
    address: { street: `${run.slice(-4)} Tracking Ln`, city: "Austin", state: "TX", zip: "78704" },
  });
  await api(owner, "post", "/v1/consent", {
    address: phone, channel: "sms", purpose: "transactional", method: "web_form", customerId,
    proofText: "Text me when the technician is on the way.",
  });
  const propertyId = await propertyOf(owner, customerId);
  await api(owner, "post", `/v1/properties/${propertyId}/pin`, { latitude: 30.25, longitude: -97.76 });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const ray = technicians.find((t) => t.displayName === "Ray Ortiz")!;
  const now = Date.now();
  const job = await api<{ id: string; visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId, summary: `No cooling ${run}`,
    visit: {
      windowStart: new Date(now - 30 * 60_000).toISOString(), windowEnd: new Date(now + 3 * 3_600_000).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [ray.id],
    },
  });
  const visitId = job.visits[0]!.id;

  /** Ray's phone: registered, the tap that says he is on his way, then the text with the link. */
  const { deviceId } = await api<{ deviceId: string }>(tech, "post", "/v1/field/devices", { installationId: `e2e-live-${run}` });
  let sequence = 0;
  const sync = (body: { operations?: { kind: string; subjectId: string }[]; positions?: { latitude: number; longitude: number }[] }) =>
    api<{ positions: { stored: number } }>(tech, "post", "/v1/field/sync", {
      deviceId,
      operations: (body.operations ?? []).map((o) => ({
        clientId: crypto.randomUUID(), sequence: ++sequence, kind: o.kind, subjectId: o.subjectId,
        occurredAt: new Date().toISOString(), payload: {},
      })),
      positions: (body.positions ?? []).map((p) => ({ ...p, accuracyMeters: 10, recordedAt: new Date().toISOString() })),
    });
  await sync({ operations: [{ kind: "visit.en_route", subjectId: visitId }] });
  const told = await api<{ sent: boolean; trackingUrl: string | null }>(tech, "post", `/v1/visits/${visitId}/on-my-way`, {
    channel: "sms", etaMinutes: 20, includeTracking: true,
  });
  expect(told.sent).toBe(true);
  const token = told.trackingUrl!.split("/j/")[1]!;

  /** One position, on the way, after the text. */
  const kept = await sync({ positions: [{ latitude: 30.27, longitude: -97.74 }] });
  expect(kept.positions.stored).toBe(1);

  /** The customer opens the link: who, how long, and where. */
  await stranger.goto(`/j/${token}`);
  const live = stranger.getByRole("region", { name: "Your technician", exact: true });
  await expect(live).toContainText("Ray is on this one.");
  await expect(live.getByRole("status")).toHaveText(/About \d+ minutes? away\./);
  await expect(live).toContainText("A rough estimate from where they are now.");
  const map = stranger.getByRole("region", { name: "Where your technician is" });
  await expect(map.getByRole("button", { name: /^Ray, / })).toBeVisible();
  await expect(map.getByRole("button", { name: "Your address" })).toBeVisible();

  /** Ray arrives, and the link stops showing where he is. */
  await sync({ operations: [{ kind: "visit.arrive", subjectId: visitId }] });
  await stranger.reload();
  await expect(stranger.getByText("Your technician has arrived, so their location is no longer shown.")).toBeVisible();
  await expect(stranger.getByRole("region", { name: "Where your technician is" })).toHaveCount(0);
  const after = await stranger.request.get(`/j/${token}/live`);
  expect(await after.json()).toMatchObject({ status: "arrived", position: null, tracking: false });

  /** The dispatcher sees where Ray was on today's map, with how long ago. */
  await blankTiles(owner);
  await owner.goto(`/schedule?view=map`);
  const wherePeople = owner.getByRole("region", { name: "Where people are now" });
  await expect(wherePeople).toContainText("Ray Ortiz");
});

test("Rebalance: the whole day proposed across technicians, shown before and after, and applied by a person", async ({ owner }) => {
  test.setTimeout(150_000);
  const DAY = dayOut(9);

  /** Where days start, on the map, so the drives can be measured. */
  const { locations } = await api<{ locations: { id: string; name: string }[] }>(owner, "get", "/v1/locations");
  const shop = locations.find((l) => l.name === "Shop") ?? locations[0]!;
  await api(owner, "post", `/v1/locations/${shop.id}/pin`, { latitude: 30.33, longitude: -97.72 });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const sam = technicians.find((t) => t.displayName === "Sam Reyes")!;
  const nia = technicians.find((t) => t.displayName === "Nia Osei")!;
  for (const t of technicians) await api(owner, "patch", `/v1/technicians/${t.id}`, { homeLocationId: shop.id });

  /**
   * Sam has one call near the shop and one far out east; Nia is already out
   * east. The far call belongs on Nia's day.
   */
  const stops = [
    { name: `Rebal near ${run}`, lng: -97.70, who: sam.id },
    { name: `Rebal far ${run}`, lng: -97.40, who: sam.id },
    { name: `Rebal east ${run}`, lng: -97.41, who: nia.id },
  ];
  for (const s of stops) {
    const customer = await newCustomer(owner, {
      name: s.name, address: { street: `${run.slice(-4)} ${s.name.split(" ")[1]} Rd`, city: "Austin", state: "TX", zip: "78723" },
    });
    const property = await propertyOf(owner, customer);
    await api(owner, "post", `/v1/properties/${property}/pin`, { latitude: 30.33, longitude: s.lng });
    await api(owner, "post", "/v1/jobs", {
      customerId: customer, propertyId: property, summary: `Service ${s.name}`,
      visit: { windowStart: at(DAY, 8), windowEnd: at(DAY, 17), estimatedDurationMinutes: 45, technicianIds: [s.who] },
    });
  }

  /** From the board, to the proposal. Nothing has moved yet. */
  await owner.goto(`/schedule?date=${DAY}`);
  await owner.getByRole("link", { name: "Rebalance the day" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Rebalance the day" })).toBeVisible();
  await expect(owner.getByRole("region", { name: "What would change" })).toContainText(/less\./);
  const moves = owner.getByRole("table", { name: "Moves" });
  const farRow = moves.getByRole("row").filter({ hasText: `Rebal far ${run}` });
  await expect(farRow).toContainText("Sam Reyes");
  await expect(farRow).toContainText("Nia Osei");
  const samDay = owner.getByRole("article", { name: "Sam Reyes's day" });
  await expect(samDay).toContainText("As it is");
  await expect(samDay).toContainText("Proposed");

  const board = async () => api<{ technicians: { id: string; visits: { customerName: string }[] }[] }>(
    owner, "get", `/v1/dispatch/board?date=${DAY}`);
  const onDay = async (technicianId: string) =>
    (await board()).technicians.find((t) => t.id === technicianId)!.visits.map((v) => v.customerName);
  expect(await onDay(sam.id)).toContain(`Rebal far ${run}`);

  /** Applied by the person looking at it. */
  await owner.getByRole("button", { name: "Apply these changes" }).click();
  await expect(owner.getByRole("status")).toContainText("Done.");
  expect(await onDay(nia.id)).toContain(`Rebal far ${run}`);
  expect(await onDay(sam.id)).not.toContain(`Rebal far ${run}`);

  /** On the board, in Nia's column. */
  await owner.goto(`/schedule?date=${DAY}`);
  await expect(owner.getByText(`Rebal far ${run}`, { exact: true })).toBeVisible();
});
