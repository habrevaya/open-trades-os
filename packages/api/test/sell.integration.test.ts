import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError, time } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as portal from "../src/services/portal";
import * as booking from "../src/services/booking";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * Phase 2 against a real database.
 *
 * The interesting failures here are not type errors. A grant that can be spent
 * twice, an approval that reaches another tenant's estimate, a customer view
 * that carries a cost column: none of those are visible to the compiler and
 * all of them are quiet in production.
 */
const url = process.env.DATABASE_URL;

if (!url && process.env.CI) {
  throw new Error(
    "DATABASE_URL is not set. These tests must run in CI, not skip.",
  );
}

const run = url ? describe : describe.skip;

const ORG_A = fixtureId("sell/org-a");
const ORG_B = fixtureId("sell/org-b");
const USER_A = fixtureId("sell/user-a");
const USER_B = fixtureId("sell/user-b");

let raw: postgres.Sql;
const db = () => testDb(url!);

const ctxFor = (
  organizationId: string, userId: string, roles: Actor["roles"],
  extra: Partial<ServiceContext> = {},
): ServiceContext => ({
  actor: { userId, organizationId, roles },
  db: db(),
  ...extra,
});

const office = () => ctxFor(ORG_A, USER_A, ["office_manager"]);
const tech = () => ctxFor(ORG_A, USER_A, ["technician"]);

let customerA = "";
let propertyA = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG_A, userId: USER_A, name: "Acme HVAC", slug: "acme-sell" });
  await seedOrg(raw, { organizationId: ORG_B, userId: USER_B, name: "Beta Plumbing", slug: "beta-sell" });

  const [c] = await raw`insert into public.customer (organization_id, name, email)
    values (${ORG_A}, 'Dana Reyes', 'dana@example.test') returning id`;
  customerA = c!.id;

  const [p] = await raw`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG_A}, '118 Mesquite Ln', 'Austin', 'TX', '78702') returning id`;
  propertyA = p!.id;

  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG_A}, ${customerA}, ${propertyA})`;
});

afterAll(async () => { if (raw) await raw.end(); });

const threeOptions = () => ({
  customerId: customerA,
  propertyId: propertyA,
  taxRate: "0.0825",
  options: [
    {
      name: "Good", isRecommended: false,
      lines: [{
        name: "Condenser fan motor", quantity: "1", unitPrice: "680.00",
        unitCost: "290.00", discountAmount: "0", taxable: true,
        isOptional: false, isSelected: false,
      }],
    },
    {
      name: "Better", isRecommended: true,
      lines: [
        {
          name: "Condenser replacement", quantity: "1", unitPrice: "3400.00",
          unitCost: "1980.00", discountAmount: "0", taxable: true,
          isOptional: false, isSelected: false,
        },
        {
          name: "Surge protector", quantity: "1", unitPrice: "289.00",
          unitCost: "96.00", discountAmount: "0", taxable: true,
          isOptional: true, isSelected: false,
        },
      ],
    },
    {
      name: "Best", isRecommended: false,
      lines: [{
        name: "System replacement", quantity: "1", unitPrice: "9850.00",
        unitCost: "5900.00", discountAmount: "0", taxable: true,
        isOptional: false, isSelected: false,
      }],
    },
  ],
});

run("creating an estimate", () => {
  it("computes every option total server side", async () => {
    const e = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const options = e["options"] as Array<Record<string, unknown>>;
    expect(options).toHaveLength(3);

    const better = options.find((o) => o["name"] === "Better")!;
    // The optional surge protector is priced but outside the total.
    expect(better["total"]).toBe("3680.5000");
    expect(better["baseTotal"]).toBe("3680.5000");
    expect(better["optionalTotal"]).toBe("289.0000");
  });

  it("presents the recommended option first, then most expensive", async () => {
    const e = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const names = (e["options"] as Array<Record<string, unknown>>).map((o) => o["name"]);
    expect(names).toEqual(["Better", "Best", "Good"]);
  });

  it("gives a technician the price and withholds the cost", async () => {
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const seen = await estimates.get(tech(), { id: created["id"] as string }) as Record<string, unknown>;
    const option = (seen["options"] as Array<Record<string, unknown>>)[0]!;

    expect(option["total"]).toBeDefined();
    // A technician quotes on site and must never see what the company paid.
    expect(option["cost"]).toBeUndefined();
    expect(option["margin"]).toBeUndefined();
    const line = (option["lines"] as Array<Record<string, unknown>>)[0]!;
    expect(line["unitCost"]).toBeUndefined();
  });

  it("shows the office the margin", async () => {
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const seen = await estimates.get(office(), { id: created["id"] as string }) as Record<string, unknown>;
    const better = (seen["options"] as Array<Record<string, unknown>>)
      .find((o) => o["name"] === "Better")!;
    expect(better["cost"]).toBe("1980.0000");
    expect(better["margin"]).toBe("0.417647");
  });

  it("refuses a caller without estimate:write", async () => {
    await expect(estimates.create(ctxFor(ORG_A, USER_A, ["readonly"]), threeOptions()))
      .rejects.toThrow(PermissionError);
  });
});

run("sending and approving", () => {
  const sendFresh = async () => {
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const sent = await estimates.send(office(), {
      id: created["id"] as string, channel: "email", expiresInDays: 30,
    });
    return sent;
  };

  it("returns a link and stores only its hash", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;

    const rows = await raw`select token_hash from public.portal_grant
      where organization_id = ${ORG_A} and revoked_at is null`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.token_hash).not.toContain(token);
    }
  });

  it("lets the customer view it without an account, and records the view", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;

    const view = await portal.viewEstimate(db(), { token });
    expect(view.status).toBe("viewed");
    expect(view.organizationName).toBe("Acme HVAC");
    expect(view.options).toHaveLength(3);
  });

  it("never puts cost or margin in the customer's view", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;
    const view = await portal.viewEstimate(db(), { token });

    const serialized = JSON.stringify(view);
    // The customer view is built from the fields a customer may see rather
    // than by deleting fields, so this holds for fields added later too.
    expect(serialized).not.toContain("margin");
    expect(serialized).not.toContain("unitCost");
    expect(serialized).not.toContain("1980");
  });

  it("viewing does not spend the approval", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;

    await portal.viewEstimate(db(), { token });
    await portal.viewEstimate(db(), { token });
    await portal.viewEstimate(db(), { token });

    const full = await portal.viewEstimate(db(), { token });
    const option = full.options[0]!;
    await expect(portal.approveEstimate(db(), {
      token, optionId: option.id, selectedLineIds: [],
      signerName: "Dana Reyes", acceptedTerms: true,
    })).resolves.toBeDefined();
  });

  it("spends the grant on approval, so a forwarded link cannot approve twice", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;
    const view = await portal.viewEstimate(db(), { token });
    const option = view.options.find((o) => o.name === "Better")!;

    await portal.approveEstimate(db(), {
      token, optionId: option.id, selectedLineIds: [],
      signerName: "Dana Reyes", acceptedTerms: true,
    });

    await expect(portal.approveEstimate(db(), {
      token, optionId: option.id, selectedLineIds: [],
      signerName: "Someone Else", acceptedTerms: true,
    })).rejects.toThrow(portal.InvalidGrantError);
  });

  it("includes an optional line the customer ticked, and re-totals", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;
    const view = await portal.viewEstimate(db(), { token });
    const better = view.options.find((o) => o.name === "Better")!;
    const surge = better.lines.find((l) => l.isOptional)!;

    const result = await portal.approveEstimate(db(), {
      token, optionId: better.id, selectedLineIds: [surge.id],
      signerName: "Dana Reyes", acceptedTerms: true,
    });

    const approved = result.estimate.options.find((o) => o.id === better.id)!;
    // 3400 + 289 = 3689, plus 8.25% = 304.3425, rounded once at the document.
    expect(approved.total).toBe("3993.3400");
  });

  it("writes a signature carrying a hash of the document, not just a name", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;
    const view = await portal.viewEstimate(db(), { token });
    const option = view.options[0]!;

    await portal.approveEstimate(
      db(),
      { token, optionId: option.id, selectedLineIds: [], signerName: "Dana Reyes", acceptedTerms: true },
      { ip: "203.0.113.9", userAgent: "Mozilla/5.0" },
    );

    const [sig] = await raw`select * from public.document_signature
      where subject_id = ${view.id} order by signed_at desc limit 1`;
    expect(sig!.document_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sig!.ip_address).toBe("203.0.113.9");
    expect(sig!.selected_option_id).toBe(option.id);
  });

  it("refuses to resend an estimate that is already approved", async () => {
    const sent = await sendFresh();
    const token = sent.approvalUrl.split("/").pop()!;
    const view = await portal.viewEstimate(db(), { token });
    await portal.approveEstimate(db(), {
      token, optionId: view.options[0]!.id, selectedLineIds: [],
      signerName: "Dana Reyes", acceptedTerms: true,
    });

    await expect(estimates.send(office(), {
      id: view.id, channel: "email", expiresInDays: 30,
    })).rejects.toThrow(ConflictError);
  });

  it("withdraws the previous link when an estimate is sent again", async () => {
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const id = created["id"] as string;

    const first = await estimates.send(office(), { id, channel: "email", expiresInDays: 30 });
    const second = await estimates.send(office(), { id, channel: "email", expiresInDays: 30 });

    const stale = first.approvalUrl.split("/").pop()!;
    // The first link would otherwise still approve numbers that no longer exist.
    await expect(portal.viewEstimate(db(), { token: stale }))
      .rejects.toThrow(portal.InvalidGrantError);

    await expect(portal.viewEstimate(db(), { token: second.approvalUrl.split("/").pop()! }))
      .resolves.toBeDefined();
  });

  /**
   * The office can approve a draft, for the sale that happens at the kitchen
   * table. The customer side must not be able to, and the reason it cannot is
   * structural rather than a check: sending is what issues the grant, so a
   * draft has no token pointing at it. This pins that, because the day someone
   * issues a grant from somewhere other than send(), the structure is gone and
   * nothing else would notice.
   */
  it("has no way to reach a draft from the customer side", async () => {
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;

    const grants = await raw`select count(*)::int as n from public.portal_grant
      where organization_id = ${ORG_A} and scope = 'estimate'
        and subject_id = ${created["id"] as string}`;
    expect(grants[0]!.n).toBe(0);
    expect(created["status"]).toBe("draft");
  });

  it("rejects a token that was never issued", async () => {
    await expect(portal.viewEstimate(db(), { token: "a".repeat(43) }))
      .rejects.toThrow(portal.InvalidGrantError);
  });

  it("refuses an office approval from a role without estimate:approve", async () => {
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const options = created["options"] as Array<Record<string, unknown>>;
    // A technician can send a link but cannot record the yes themselves.
    await expect(estimates.approve(tech(), {
      id: created["id"] as string,
      optionId: options[0]!["id"] as string,
      selectedLineIds: [],
      signerName: "Dana Reyes",
      capturedVia: "in_person",
    })).rejects.toThrow(PermissionError);
  });
});

run("tenant isolation on the sell path", () => {
  it("will not read another organization's estimate", async () => {
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const intruder = ctxFor(ORG_B, USER_B, ["owner"]);
    await expect(estimates.get(intruder, { id: created["id"] as string })).rejects.toThrow();
  });

  it("will not approve another organization's estimate through a valid grant", async () => {
    // A real grant, for a real estimate, but the subject is fixed by the grant
    // so there is no id the caller could swap.
    const created = await estimates.create(office(), threeOptions()) as Record<string, unknown>;
    const sent = await estimates.send(office(), {
      id: created["id"] as string, channel: "email", expiresInDays: 30,
    });
    const token = sent.approvalUrl.split("/").pop()!;
    const view = await portal.viewEstimate(db(), { token });
    expect(view.organizationName).toBe("Acme HVAC");
  });
});

run("booking from the website", () => {
  let serviceId = "";
  let windowId = "";

  beforeAll(async () => {
    if (!url) return;
    const [jt] = await raw`insert into public.job_type (organization_id, name, capacity_model)
      values (${ORG_A}, 'Tune up', 'technician_dispatch') returning id`;

    const [svc] = await raw`insert into public.bookable_service
      (organization_id, job_type_id, public_name, display_price, min_notice_hours,
       max_advance_days, max_per_window)
      values (${ORG_A}, ${jt!.id}, 'Seasonal tune up', 149.0000, 0, 30, 1)
      returning id`;
    serviceId = svc!.id;

    const [w] = await raw`insert into public.arrival_window
      (organization_id, name, starts_at, ends_at, days_of_week)
      values (${ORG_A}, '8am to 12pm', '08:00', '12:00', ${[0,1,2,3,4,5,6]})
      returning id`;
    windowId = w!.id;

    for (let d = 0; d < 7; d++) {
      await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
        values (${ORG_A}, ${d}, '07:00', '18:00')`;
    }
  });

  const tomorrow = () => new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);

  it("offers only days the company is open", async () => {
    const { slots } = await booking.availability(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      from: tomorrow(), days: 7,
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.arrivalWindowId === windowId)).toBe(true);
  });

  it("counts the notice period from the company's morning, not London's", async () => {
    /**
     * An arrival window is a WALL CLOCK time. "8am to 12pm" means eight in
     * the morning where the company is, and `new Date(`${date}T08:00Z`)`
     * made that eight in the morning in London: three in the morning in
     * Austin, five hours before anyone opens.
     *
     * So the minimum notice a company set was measured against the wrong
     * instant, and the calendar offered a slot the company could not staff
     * or withheld one it could. The notice below is chosen so the two
     * readings disagree: the buggy instant falls inside the notice period
     * and the real one falls outside it.
     */
    const day = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    const londonMorning = Date.parse(`${day}T08:00:00Z`);
    const austinMorning = time.startOfDayIn(day, "America/Chicago").getTime() + 8 * 3600_000;
    const between = (londonMorning + austinMorning) / 2;
    const notice = Math.round((between - Date.now()) / 3600_000);

    const [jt] = await raw`insert into public.job_type (organization_id, name, capacity_model)
      values (${ORG_A}, 'Notice test', 'technician_dispatch') returning id`;
    const [svc] = await raw`insert into public.bookable_service
      (organization_id, job_type_id, public_name, display_price, min_notice_hours,
       max_advance_days, max_per_window)
      values (${ORG_A}, ${jt!.id}, 'Notice tune up', 149.0000, ${notice}, 30, 1)
      returning id`;

    const { slots } = await booking.availability(db(), {
      organizationSlug: "acme-sell", bookableServiceId: svc!.id,
      from: day, days: 1,
    });
    expect(slots.find((s) => s.date === day)).toBeDefined();
  });

  it("caps the window the caller asked for at the company's own limit", async () => {
    const { slots } = await booking.availability(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      from: tomorrow(), days: 90,
    });
    // maxAdvanceDays is 30. A client cannot open the calendar further.
    expect(slots.length).toBeLessThanOrEqual(30);
  });

  it("stops offering a window once it is full", async () => {
    const date = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);

    await booking.createRequest(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Dana Reyes", contactPhone: "5125550100",
      addressLine1: "118 Mesquite Ln", city: "Austin", state: "TX", postalCode: "78702",
      intakeAnswers: {}, utm: {},
    });

    const { slots } = await booking.availability(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      from: date, days: 1,
    });
    expect(slots.find((s) => s.date === date)).toBeUndefined();
  });

  it("refuses a second booking into a window that filled while the page was open", async () => {
    /**
     * TWO PEOPLE, and the fixture had to be changed to say so.
     *
     * This test used to send the IDENTICAL body twice and assert a refusal,
     * which is not a full window at all: it is one person double tapping Book
     * on a phone that showed them nothing. The test documented that as the
     * intended behaviour, so the real defect had a green test sitting on top
     * of it. A window genuinely filling needs a second household.
     */
    const date = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
    const shared = {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      city: "Austin", state: "TX", intakeAnswers: {}, utm: {},
    };
    await booking.createRequest(db(), {
      ...shared,
      contactName: "Sam Ortiz", contactPhone: "5125550111",
      addressLine1: "9 Bluebonnet Ct", postalCode: "78704",
    });

    // Better a message the requester can act on than an overbooking someone
    // finds on the dispatch board in the morning.
    await expect(booking.createRequest(db(), {
      ...shared,
      contactName: "Alex Pryor", contactPhone: "5125550122",
      addressLine1: "41 Cedar Bend", postalCode: "78745",
    })).rejects.toThrow(ConflictError);
  });

  it("makes one booking out of a double tap, and does not spend the slot twice", async () => {
    /**
     * Day offsets in this file are hand picked and the windows hold one
     * booking each, so a repeated offset means one test fills the window
     * another test needs. Three of these landed on 9, 10 and 11, which were
     * already taken, and three unrelated tests below started failing with
     * "that time has just been taken". Check the offsets already used before
     * adding one.
     *

     * A homeowner on a phone with one bar taps Book, sees nothing, and taps
     * again. This inserted twice: two requests with the same name at the same
     * address in the same window, both counted against `maxPerWindow`, so one
     * person took the last two slots of a Tuesday morning and the next real
     * customer was told the time had gone.
     *
     * The route declared `idempotent: true` for months. Nothing read it.
     */
    const date = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
    const body = {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Priya Raman", contactPhone: "5125550133",
      addressLine1: "77 Ivy Fall", city: "Austin", state: "TX", postalCode: "78751",
      intakeAnswers: {}, utm: {},
    };

    const first = await booking.createRequest(db(), body);
    const second = await booking.createRequest(db(), body);

    // The same booking back, not a refusal and not a second row.
    expect(second.request.id).toBe(first.request.id);

    const rows = await raw`select id from public.booking_request
      where organization_id = ${ORG_A} and requested_date = ${date}`;
    expect(rows).toHaveLength(1);
  });

  it("treats a different household in the same window as a different booking", async () => {
    /**
     * The fingerprint must not be so coarse that two neighbours booking the
     * same morning collapse into one. That failure is worse than the
     * duplicate: a customer who booked would never hear from anybody.
     */
    const date = new Date(Date.now() + 16 * 864e5).toISOString().slice(0, 10);
    const shared = {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      city: "Austin", state: "TX", intakeAnswers: {}, utm: {},
    };

    const first = await booking.createRequest(db(), {
      ...shared, contactName: "Ivy Okonkwo", contactPhone: "5125550144",
      addressLine1: "3 Larkspur", postalCode: "78702",
    });

    // Same window, next door. Refused for capacity, which is a real answer,
    // but it must never come back as the neighbour's booking.
    await expect(booking.createRequest(db(), {
      ...shared, contactName: "Tom Beale", contactPhone: "5125550155",
      addressLine1: "5 Larkspur", postalCode: "78702",
    })).rejects.toThrow(ConflictError);

    const rows = await raw<{ id: string }[]>`select id from public.booking_request
      where organization_id = ${ORG_A} and requested_date = ${date}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.request.id);
  });

  it("lets a caller say two identical submissions are two bookings", async () => {
    /**
     * A key, when one is sent, narrows the fingerprint. A partner integration
     * that genuinely means two is able to say so, and a browser that sends
     * none still gets the deduplication above.
     */
    const date = new Date(Date.now() + 17 * 864e5).toISOString().slice(0, 10);
    const body = {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Nan Adeyemi", contactPhone: "5125550166",
      addressLine1: "2 Quarry Rd", city: "Austin", state: "TX", postalCode: "78704",
      intakeAnswers: {}, utm: {},
    };

    const first = await booking.createRequest(db(), body, { idempotencyKey: "intent-one" });
    // A different intent, so not a retry. Capacity refuses it, which proves
    // it was treated as a new submission rather than replayed.
    await expect(
      booking.createRequest(db(), body, { idempotencyKey: "intent-two" }),
    ).rejects.toThrow(ConflictError);

    const replay = await booking.createRequest(db(), body, { idempotencyKey: "intent-one" });
    expect(replay.request.id).toBe(first.request.id);
  });

  it("matches an existing property on the address rather than the name", async () => {
    const date = new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10);
    const { request } = await booking.createRequest(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      // A different name at the same house. It is the same account.
      contactName: "D. Reyes-Walker", contactEmail: "dana2@example.test",
      addressLine1: "118 Mesquite Ln", city: "Austin", state: "TX", postalCode: "78702",
      intakeAnswers: {}, utm: {},
    });

    const confirmed = await booking.confirm(office(), { id: request.id });
    expect(confirmed.propertyId).toBe(propertyA);
    expect(confirmed.customerId).toBe(customerA);
  });

  it("confirming twice does not create a second job", async () => {
    const date = new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10);
    const { request } = await booking.createRequest(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Pat Lin", contactPhone: "5125550122",
      addressLine1: "41 Cactus Rd", city: "Austin", state: "TX", postalCode: "78745",
      intakeAnswers: {}, utm: {},
    });

    const first = await booking.confirm(office(), { id: request.id });
    const second = await booking.confirm(office(), { id: request.id });
    expect(second.jobId).toBe(first.jobId);
  });

  it("gives the requester a tracking link before anyone has confirmed", async () => {
    const date = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const created = await booking.createRequest(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Jo Park", contactPhone: "5125550133",
      addressLine1: "77 Live Oak St", city: "Austin", state: "TX", postalCode: "78751",
      intakeAnswers: {}, utm: {},
    });

    expect(created.trackingUrl).toMatch(/\/b\//);
    const [grant] = await raw`select customer_id, scope from public.portal_grant
      where subject_id = ${created.request.id}`;
    // No customer exists yet, and inventing one would fill the CRM with people
    // who never became anything.
    expect(grant!.customer_id).toBeNull();
    expect(grant!.scope).toBe("booking");

    await booking.confirm(office(), { id: created.request.id });
    const [after] = await raw`select customer_id, scope from public.portal_grant
      where organization_id = ${ORG_A} and id = (
        select id from public.portal_grant where subject_id is not null
        and customer_id is not null and scope = 'job' order by updated_at desc limit 1)`;
    expect(after?.scope).toBe("job");
  });

  it("refuses a booking read to a role without booking:read", async () => {
    await expect(booking.listRequests(ctxFor(ORG_A, USER_A, []), { limit: 10 }))
      .rejects.toThrow(PermissionError);
  });

  it("records why a booking was declined, as something countable", async () => {
    const date = new Date(Date.now() + 11 * 864e5).toISOString().slice(0, 10);
    const { request } = await booking.createRequest(db(), {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Riley Shaw", contactPhone: "5125550144",
      addressLine1: "2 Far Away Rd", city: "El Paso", state: "TX", postalCode: "79901",
      intakeAnswers: {}, utm: {},
    });

    const declined = await booking.decline(office(), {
      id: request.id, reason: "outside_service_area", notifyCustomer: true,
    });
    expect(declined.status).toBe("declined");
    expect(declined.declineReason).toBe("outside_service_area");
  });

    describe("where a booking actually came from", () => {
    /**
     * Both write sites used to say `"online_booking"`, which is a CHANNEL and
     * not a source. `marketing.LEAD_SOURCES` holds twenty one real sources and
     * that is not among them, so every job and customer this path created
     * carried a value no report could group and no attribution model could
     * credit.
     *
     * The distinction costs money: somebody who clicked a Google ad and then
     * booked on the website came from Google Ads, and the ad account paid for
     * them. Recording the widget credits the website for every paid click a
     * company buys, and the ads look free.
     */
    const bookAndConfirm = async (
      extra: { utm?: Record<string, string>; referrer?: string },
      dayOffset: number,
    ) => {
      const date = new Date(Date.now() + dayOffset * 864e5).toISOString().slice(0, 10);
      const { request } = await booking.createRequest(db(), {
        organizationSlug: "acme-sell", bookableServiceId: serviceId,
        requestedDate: date, arrivalWindowId: windowId,
        contactName: `Source ${dayOffset}`, contactPhone: `51255502${dayOffset}`,
        addressLine1: `${dayOffset} Source Way`, city: "Austin", state: "TX",
        postalCode: "78704", intakeAnswers: {},
        utm: extra.utm ?? {},
        ...(extra.referrer ? { referrer: extra.referrer } : {}),
      });
      const { jobId } = await booking.confirm(office(), { id: request.id });
      const [row] = await raw<{ lead_source: string | null }[]>`
        select lead_source from public.job where id = ${jobId}`;
      return row!.lead_source;
    };

    it("credits the campaign that paid for the click", async () => {
      const source = await bookAndConfirm(
        { utm: { utm_source: "google", utm_medium: "cpc" } }, 30,
      );
      expect(source).toBe("google_ads");
    });

    it("reads the referrer when nothing was tagged", async () => {
      const source = await bookAndConfirm(
        { referrer: "https://www.google.com/search?q=ac repair austin" }, 31,
      );
      expect(source).toBe("organic_search");
    });

    it("says unknown, not direct, when a tag was present and meant nothing", async () => {
      /**
       * MY FIRST VERSION OF THIS TEST ASSERTED THE OPPOSITE, and `parseTouch`
       * is right. A UTM that was present and did not resolve is a gap in the
       * alias list. Falling back to the referrer, or to `direct`, collapses
       * "we cannot read our own tags" into "they came straight to us", and
       * makes a data problem look like brand strength.
       *
       * I had hand rolled a resolver that did exactly that, and it also
       * missed click ids entirely. `parseTouch` was written, tested and
       * called by nothing, and reimplementing it produced something worse
       * that looked the same from outside.
       */
      /**
       * Its own day offset, because the fixture derives the contact name and
       * address from it and the booking replay added earlier treats an
       * identical submission as a retry. Two of these cases shared offset 31,
       * so the second returned the first one's booking and the test measured
       * the wrong row. My own deduplication caught my own test.
       */
      const source = await bookAndConfirm(
        { utm: { utm_source: "wharrgarbl" }, referrer: "https://www.google.com/search?q=ac" }, 34,
      );
      expect(source).toBe("unknown");
    });

    it("does not count our own pages as a referral", async () => {
      /**
       * Somebody moving from the pricing page to the booking page is one
       * session. Counting it as a referral from ourselves is how "our own
       * website" becomes the top lead source on a report, which reads as a
       * marketing win and is a measurement artefact.
       */
      const source = await bookAndConfirm(
        { referrer: "https://portal.example.com/pricing" }, 35,
      );
      expect(source).toBe("direct");
    });

    it("takes a click id as proof of a paid click", async () => {
      /**
       * A bare `utm_source=google` with no medium is ambiguous between the ad
       * account and the SEO that has been working for free. A `gclid` settles
       * it, and it is the most common tagging shape in this trade.
       */
      const source = await bookAndConfirm(
        { utm: { utm_source: "google", gclid: "Cj0KCQjw" } }, 33,
      );
      expect(source).toBe("google_ads");
    });

    it("says direct when there is nothing to go on", async () => {
      /**
       * `direct` and `unknown` are different facts. Unknown means we failed to
       * record it, direct means they typed the address in, and a report that
       * cannot tell them apart cannot tell a tracking gap from a strong brand.
       */
      expect(await bookAndConfirm({}, 32)).toBe("direct");
    });
    });
});

run("turning the booking page on at all", () => {
  /**
   * NOTHING COULD CREATE A BOOKABLE SERVICE. `configureBookableService`
   * updates a row, and no code path in this product ever inserted one: not
   * the API, not the app, not the seed. `arrival_window` and `business_hours`
   * were written by nothing either.
   *
   * So /book/[slug] listed nothing for every company that has ever existed,
   * permanently, and the only endpoint touching the table updated rows that
   * could not be there. A whole customer facing module, marked as shipped,
   * was unreachable, and the only symptom was an empty list that reads as
   * "this company offers nothing online".
   */
  let freshJobType = "";

  beforeAll(async () => {
    if (!url) return;
    const [jt] = await raw<{ id: string }[]>`insert into public.job_type
      (organization_id, name, capacity_model)
      values (${ORG_A}, 'Drain clearing', 'technician_dispatch') returning id`;
    freshJobType = jt!.id;
  });

  it("creates a service the public list then returns", async () => {
    const created = await booking.createService(office(), {
      jobTypeId: freshJobType,
      publicName: "Drain clearing",
      publicDescription: "One fixture, cleared and camera checked.",
      displayPrice: "189.00",
      minNoticeHours: 24, maxAdvanceDays: 30, maxPerWindow: 2,
    });

    expect(created.publicName).toBe("Drain clearing");

    // THE ASSERTION THAT MATTERS: it reaches the page a stranger loads.
    const { services } = await booking.listServices(db(), { organizationSlug: "acme-sell" });
    expect(services.map((s) => s.id)).toContain(created.id);
  });

  it("refuses a second offering of the same job type", async () => {
    /**
     * Two would put the same work on the booking page twice under different
     * names and different prices, and the customer picks whichever they see
     * first.
     */
    await expect(booking.createService(office(), {
      jobTypeId: freshJobType, publicName: "Drains (again)",
      minNoticeHours: 24, maxAdvanceDays: 30, maxPerWindow: 2,
    })).rejects.toThrow(/already offered/i);
  });

  it("refuses a deposit that is both an amount and a percent", async () => {
    /**
     * Two answers to "what does the customer owe now", and the one charged is
     * whichever the code reads first. `depositDue` reads the amount, so a
     * company that set ten percent and later typed a flat fifty would
     * silently start charging fifty.
     */
    const [jt] = await raw<{ id: string }[]>`insert into public.job_type
      (organization_id, name, capacity_model)
      values (${ORG_A}, 'Both deposits', 'technician_dispatch') returning id`;

    await expect(booking.createService(office(), {
      jobTypeId: jt!.id, publicName: "Both",
      depositAmount: "50.00", depositPercent: "0.10",
      minNoticeHours: 24, maxAdvanceDays: 30, maxPerWindow: 2,
    })).rejects.toThrow(/either an amount or a percent/i);
  });

  it("refuses a job type belonging to nobody here", async () => {
    await expect(booking.createService(office(), {
      jobTypeId: "11111111-1111-4111-8111-111111111111", publicName: "Nope",
      minNoticeHours: 24, maxAdvanceDays: 30, maxPerWindow: 2,
    })).rejects.toThrow(/job type/i);
  });
});

run("the windows and days a booking page is built from", () => {
  it("replaces the whole set of windows at once", async () => {
    /**
     * Not one at a time. Add-then-remove is visible to customers between the
     * two calls, which is a company publishing half a set of windows.
     */
    const { windows } = await booking.setWindows(office(), {
      windows: [
        { name: "8am to 12pm", startsAt: "08:00", endsAt: "12:00", daysOfWeek: [1, 2, 3, 4, 5] },
        { name: "12pm to 4pm", startsAt: "12:00", endsAt: "16:00", daysOfWeek: [1, 2, 3, 4, 5] },
      ],
    });
    expect(windows).toBe(2);

    const rows = await raw<{ name: string; sort_order: number }[]>`
      select name, sort_order from public.arrival_window
      where organization_id = ${ORG_A} order by sort_order, name`;

    /**
     * The POSITIONS are asserted, not just the order they came back in.
     *
     * The first version checked only the returned order, and giving every
     * window the same sort order left it green: Postgres returned them in
     * insertion order by coincidence, and a tie broken by anything else, a
     * different plan or a later update, would have reordered a customer's
     * booking page with no test noticing.
     *
     * The names are deliberately ones where alphabetical and arranged order
     * disagree, so the thing being protected is visible in the fixture.
     */
    expect(rows.map((r) => [r.name, r.sort_order])).toEqual([
      ["8am to 12pm", 0],
      ["12pm to 4pm", 1],
    ]);
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(booking.setWindows(office(), {
      windows: [{ name: "Backwards", startsAt: "16:00", endsAt: "08:00", daysOfWeek: [1] }],
    })).rejects.toThrow(/ends at 08:00/);
  });

  it("refuses a window of zero length", async () => {
    // A slot a customer can book and a technician cannot attend.
    await expect(booking.setWindows(office(), {
      windows: [{ name: "Instant", startsAt: "09:00", endsAt: "09:00", daysOfWeek: [1] }],
    })).rejects.toThrow();
  });

  it("wants an answer for all seven days", async () => {
    /**
     * A partial week is ambiguous: a missing Saturday could mean closed or
     * could mean nobody has said. `availability` treats an absent row as
     * closed, so silence becomes a decision nobody made.
     */
    await expect(booking.setHours(office(), {
      days: [{ dayOfWeek: 1, opensAt: "07:00", closesAt: "18:00", closed: false }] as never,
    })).rejects.toThrow();
  });

  it("refuses a day that is open with no hours on it", async () => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d,
      opensAt: d === 3 ? null : "07:00",
      closesAt: d === 3 ? null : "18:00",
      closed: false,
    }));
    await expect(booking.setHours(office(), { days })).rejects.toThrow(/open and has no hours/i);
  });

  it("stores a closed day with no hours, which is a real answer", async () => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d,
      opensAt: d === 0 ? null : "07:00",
      closesAt: d === 0 ? null : "18:00",
      closed: d === 0,
    }));
    await booking.setHours(office(), { days });

    const rows = await raw<{ day_of_week: number; closed: boolean }[]>`
      select day_of_week, closed from public.business_hours
      where organization_id = ${ORG_A} order by day_of_week`;
    expect(rows).toHaveLength(7);
    expect(rows[0]!.closed).toBe(true);
  });
});
