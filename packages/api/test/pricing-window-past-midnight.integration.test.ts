import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor, Permission } from "@opentradesos/core";
import * as apps from "../src/services/apps";
import * as plugins from "../src/services/plugins";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as priceBook from "../src/services/pricebook";
import * as billing from "../src/services/billing";
import { UnprocessableError, type ServiceContext } from "../src/services/context";
import { resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A PRICING WINDOW THAT RUNS PAST MIDNIGHT, THROUGH A REAL INVOICE
 *
 * An application registers "from 18:00 to 06:00, starting Monday" as one rule,
 * and the invoice for a job whose first visit is at three on Tuesday morning is
 * priced with it, because the window that holds that hour started on Monday.
 * The same job at three on Monday morning, or at three in the afternoon, is
 * not. Core's unit tests hold the arithmetic; this holds that the registered
 * rule is read back as it was written and the invoice agrees.
 *
 * 2026-11-09 is a Monday, in Chicago, where the company is.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pricing-window:org");
const USER = fixtureId("pricing-window:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let itemId = "";
let pricer: { id: string; ctx: () => ServiceContext };

async function appWith(name: string, permissions: Permission[]) {
  const app = await apps.install(owner(), {
    name, permissions, scopes: { customer: "all", job: "all", visit: "all", estimate: "all", invoice: "all" },
  });
  const { token } = await apps.issueToken(owner(), { appId: app.id });
  const resolved = await apps.resolveToken(db(), token);
  return { id: app.id, ctx: (): ServiceContext => ({ actor: resolved!.actor, db: db() }) };
}

/** A job whose one visit starts at a local time, and an invoice for it priced from the price book. */
async function invoiceFor(localStart: string) {
  const job = await jobs.create(owner(), { customerId, propertyId, summary: "Night call", tags: [], customFields: {} });
  await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job.id}, 'scheduled', (${localStart}::timestamp at time zone ${ZONE}),
            (${localStart}::timestamp at time zone ${ZONE}) + interval '2 hours', 120)`;
  const invoice = await billing.create(owner(), {
    customerId, jobId: job.id, draft: true,
    lines: [{ priceBookItemId: itemId, name: "Tune up", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false }],
  });
  return invoice;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Night Window Co", slug: "pricing-window-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Nia Night", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "2 Night Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
  itemId = (await priceBook.create(owner(), { kind: "service", code: "TUNE", name: "Tune up", price: "200.00", taxable: false })).id;
  pricer = await appWith("Night pricer", ["pricebook:write", "customer:read", "job:read", "visit:read"]);
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("a pricing rule for a window that runs past midnight", () => {
  it("is registered as one rule and read back as it was written", async () => {
    const registered = await plugins.registerPricingRule(pricer.ctx(), {
      key: "night", name: "Night call", rule: { kind: "time_window", window: { days: [1], from: "18:00", to: "06:00" }, percent: "50" },
    });
    expect(registered).toMatchObject({ changed: true, plugin: { version: 1, kind: "pricing_rule" } });
    expect(registered.plugin.summary).toBe("50% added for work from 18:00 on Mon until 06:00 the next day.");
  });

  it("prices the night after a listed day, and the evening of it, and not the morning of it or the afternoon", async () => {
    // Monday evening, and the small hours of Tuesday: both in the window that started on Monday.
    expect((await invoiceFor("2026-11-09T19:00")).total).toBe("300.0000");
    const small = await invoiceFor("2026-11-10T03:00");
    expect(small.total).toBe("300.0000");
    expect(small.lines[0]!.pricingRules).toEqual([expect.objectContaining({
      name: "Night call", appName: "Night pricer", kind: "time_window", amount: "100.0000",
    })]);
    // Monday at three in the morning belongs to a window that started on Sunday, which is not listed.
    expect((await invoiceFor("2026-11-09T03:00")).total).toBe("200.0000");
    // Tuesday afternoon, and Tuesday evening (Tuesday is not listed), are outside it.
    expect((await invoiceFor("2026-11-10T15:00")).total).toBe("200.0000");
    expect((await invoiceFor("2026-11-10T20:00")).total).toBe("200.0000");
  });

  it("is still refused when it starts and ends at the same time, or starts at 24:00, in words", async () => {
    const refused = (window: { days: number[]; from: string; to: string }) => plugins.registerPricingRule(pricer.ctx(), {
      key: "bad_window", name: "Bad", rule: { kind: "time_window", window, percent: "10" },
    }).catch((e: unknown) => e);
    const same = await refused({ days: [1], from: "06:00", to: "06:00" });
    expect(same).toBeInstanceOf(UnprocessableError);
    expect((same as UnprocessableError).issues.map((i) => i.message).join(" ")).toMatch(/start and end at different times/);
    const late = await refused({ days: [1], from: "24:00", to: "06:00" });
    expect((late as UnprocessableError).issues.map((i) => i.message).join(" ")).toMatch(/cannot start at 24:00/);
  });

  it("keeps a window inside one day working as it did", async () => {
    await plugins.registerPricingRule(pricer.ctx(), {
      key: "night", name: "Night call", rule: { kind: "time_window", window: { days: [2], from: "08:00", to: "17:00" }, percent: "10" },
    });
    expect((await invoiceFor("2026-11-10T09:00")).total).toBe("220.0000");
    expect((await invoiceFor("2026-11-10T03:00")).total).toBe("200.0000");
  });
});
