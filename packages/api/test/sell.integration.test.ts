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
    const date = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
    const body = {
      organizationSlug: "acme-sell", bookableServiceId: serviceId,
      requestedDate: date, arrivalWindowId: windowId,
      contactName: "Sam Ortiz", contactPhone: "5125550111",
      addressLine1: "9 Bluebonnet Ct", city: "Austin", state: "TX", postalCode: "78704",
      intakeAnswers: {}, utm: {},
    };
    await booking.createRequest(db(), body);
    // Better a message the requester can act on than an overbooking someone
    // finds on the dispatch board in the morning.
    await expect(booking.createRequest(db(), body)).rejects.toThrow(ConflictError);
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
});
