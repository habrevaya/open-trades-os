import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as entitlements from "../src/services/entitlements";
import * as agreements from "../src/services/agreements";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { ConflictError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHO IS PAYING FOR THIS, AND WHY
 *
 * The research this project started from called it the single most
 * load-bearing missing concept in the products contractors already use, and
 * the distinction that pays for the module is this one:
 *
 *   A zero dollar visit under an agreement and a zero dollar visit that is
 *   our own rework look identical on a revenue report and mean opposite
 *   things about the business.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ent:org");
const USER = fixtureId("ent:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cover Co", slug: "cover-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Cara Cover", phone: "+15125550199",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "4 Cover Ct", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw.unsafe("set session_replication_role = replica");
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw.unsafe("set session_replication_role = origin");
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  await raw`delete from public.invoice where organization_id = ${ORG}`;
  await raw`delete from public.entitlement where organization_id = ${ORG}`;
  await raw`delete from public.deferred_revenue_entry where organization_id = ${ORG}`;
  await raw`delete from public.agreement_billing where organization_id = ${ORG}`;
  await raw`delete from public.agreement_visit where organization_id = ${ORG}`;
  await raw`delete from public.agreement where organization_id = ${ORG}`;
  await raw`delete from public.agreement_plan where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
});

const newJob = async (summary = "Cover job") =>
  jobs.create(owner(), { customerId, propertyId, summary, tags: [], customFields: {} });

run("recording who is paying", () => {
  it("fills in the source's defaults", async () => {
    /**
     * The pair people get backwards. A parts warranty covers the part and
     * not the labour; getting it the other way round bills a customer for
     * something a manufacturer owed.
     */
    const job = await newJob();
    const row = await entitlements.resolve(owner(), { jobId: job.id, source: "parts_warranty" });
    expect(row.coversParts).toBe(true);
    expect(row.coversLabour).toBe(false);
  });

  it("lets the office override a default", async () => {
    // Because the paperwork in front of them beats our guess about it.
    const job = await newJob();
    const row = await entitlements.resolve(owner(), {
      jobId: job.id, source: "parts_warranty", coversLabour: true,
      externalReference: "RA-4471",
    });
    expect(row.coversLabour).toBe(true);
    expect(row.externalReference).toBe("RA-4471");
  });

  it("keeps one answer per job, not two", async () => {
    // Two resolutions on one job is two answers to "who is paying", and
    // every reader downstream would have to pick one.
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "goodwill" });
    await entitlements.resolve(owner(), { jobId: job.id, source: "insurance" });

    const rows = await raw`select id from public.entitlement where job_id = ${job.id}`;
    expect(rows).toHaveLength(1);
    expect((await entitlements.forJob(owner(), { jobId: job.id }))!.source).toBe("insurance");
  });

  it("says nothing when nobody has decided", async () => {
    const job = await newJob();
    expect(await entitlements.forJob(owner(), { jobId: job.id })).toBeNull();
  });
});

run("what the customer actually owes", () => {
  const charges = [
    { kind: "labour" as const, amount: "300.00" },
    { kind: "parts" as const, amount: "200.00" },
  ];

  it("is everything when nobody else is covering it", async () => {
    const job = await newJob();
    const quote = await entitlements.quote(owner(), { jobId: job.id, charges });
    expect(quote.customer).toBe("500.0000");
    expect(quote.source).toBe("customer");
  });

  it("is the labour under a parts warranty", async () => {
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "parts_warranty" });
    const quote = await entitlements.quote(owner(), { jobId: job.id, charges });
    expect(quote.customer).toBe("300.0000");
    expect(quote.covered).toBe("200.0000");
  });

  it("is the deductible under insurance, charged once", async () => {
    // Splitting line by line and adding the deductible to each is how a
    // customer gets charged their excess four times.
    const job = await newJob();
    await entitlements.resolve(owner(), {
      jobId: job.id, source: "insurance", customerResponsibility: "100.0000",
    });
    const quote = await entitlements.quote(owner(), { jobId: job.id, charges });
    expect(quote.customer).toBe("100.0000");
    expect(quote.covered).toBe("400.0000");
  });
});

run("work the customer must not be billed for", () => {
  /**
   * A guard rather than a calculation, and deliberately. The sources it
   * refuses on are the ones where billing the customer is not a pricing
   * question but a mistake: we are back because of something we did, or we
   * chose to absorb it. Rework billed to a customer is the complaint that
   * ends a relationship, and it happens because the person invoicing was not
   * the person who decided.
   */
  const line = (name: string, unitPrice: string) => ({
    name, quantity: "1", unitPrice, discountAmount: "0", taxable: false,
  });

  it("refuses to invoice a customer for our own callback", async () => {
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "no_charge_callback" });

    await expect(billing.create(owner(), {
      customerId, jobId: job.id, lines: [line("Labour, 2 hours", "300.00")],
    })).rejects.toThrow(ConflictError);
  });

  it("names the reason, rather than saying no", async () => {
    // Whoever is invoicing did not make this decision, so the refusal has to
    // carry it.
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "goodwill" });

    await expect(billing.create(owner(), {
      customerId, jobId: job.id, lines: [line("Labour, 2 hours", "300.00")],
    })).rejects.toThrow(/absorb/);
  });

  it("allows a chargeable extra on a covered job when somebody says so", async () => {
    /**
     * A callback can have one chargeable extra on it. Refusing that would
     * make the guard something people work around rather than with, which
     * is how a guard stops being one.
     */
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "no_charge_callback" });

    const invoice = await billing.create(owner(), {
      customerId, jobId: job.id,
      // Named so it classifies as labour, which the callback would otherwise
      // cover. The explicit source is the only thing letting it through.
      lines: [{ ...line("Labour to fit the thermostat they asked for", "180.00"), coverageSource: "customer" as const }],
    });
    expect(invoice.total).toBe("180.0000");
  });

  it("does not refuse a warranty job for the part the customer does pay for", async () => {
    // A parts warranty covers the part. The labour is the customer's, and
    // refusing it would be the guard getting the pair backwards.
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "parts_warranty" });

    await expect(billing.create(owner(), {
      customerId, jobId: job.id, lines: [line("Labour, 2 hours", "300.00")],
    })).resolves.toBeTruthy();
  });

  it("refuses a line nobody could classify when the coverage is total", async () => {
    /**
     * Everywhere else an unclassifiable line is the customer's, because
     * guessing the other way loses revenue. Here the risk runs the other
     * way: a callback is a job where the answer is already "nothing", and a
     * badly named line is exactly how a customer ends up invoiced for
     * rework.
     */
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "no_charge_callback" });
    await expect(billing.create(owner(), {
      customerId, jobId: job.id, lines: [line("Sundries", "45.00")],
    })).rejects.toThrow(ConflictError);
  });

  it("does not refuse an invoice with nothing on it that is covered", async () => {
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "our_warranty", coversParts: false });
    await expect(billing.create(owner(), {
      customerId, jobId: job.id, lines: [line("Replacement capacitor", "40.00")],
    })).resolves.toBeTruthy();
  });
});

run("what the document says", () => {
  it("carries the coverage source on every line, which the contract has always promised", async () => {
    /**
     * `invoice_line.entitlement_id` has had a column and a comment since the
     * first migration and nothing wrote it, while the API contract returned
     * a `coverageSource` on every line that was always null.
     */
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "home_warranty" });

    const invoice = await billing.create(owner(), {
      customerId, jobId: job.id,
      lines: [{ name: "Trade call fee", quantity: "1", unitPrice: "75.00", discountAmount: "0", taxable: false }],
    });
    expect(invoice.lines[0]!.coverageSource).toBe("home_warranty");
  });

  it("leaves a line the office marked chargeable uncovered", async () => {
    // So the document does not later claim a chargeable extra was paid for
    // by a warranty.
    const job = await newJob();
    await entitlements.resolve(owner(), { jobId: job.id, source: "home_warranty" });

    const invoice = await billing.create(owner(), {
      customerId, jobId: job.id,
      lines: [{
        name: "Upgrade they asked for", quantity: "1", unitPrice: "120.00",
        discountAmount: "0", taxable: false, coverageSource: "customer" as const,
      }],
    });
    expect(invoice.lines[0]!.coverageSource).toBeNull();
  });
});

run("what we did for nothing, and why", () => {
  it("separates work we absorbed from work somebody else is paying for", async () => {
    /**
     * The number nobody has and everybody needs. Both read as zero revenue
     * on every other report in the product.
     */
    const a = await newJob("Callback");
    const b = await newJob("Plan visit");
    await entitlements.resolve(owner(), { jobId: a.id, source: "no_charge_callback" });
    await entitlements.resolve(owner(), { jobId: b.id, source: "agreement" });

    const report = await entitlements.bySource(owner());
    expect(report.find((r) => r.source === "no_charge_callback")!.ourCost).toBe(true);
    expect(report.find((r) => r.source === "agreement")!.ourCost).toBe(false);
    expect(report.find((r) => r.source === "no_charge_callback")!.jobs).toBe(1);
  });
});

run("an agreement writes it down by itself", () => {
  it("marks a booked plan visit as covered by the plan", async () => {
    /**
     * Because relying on somebody to set it is relying on somebody to
     * remember, and the report is worthless the first time they do not.
     */
    const plan = await agreements.createPlan(owner(), {
      name: "Cover Club", price: "228.00", billingFrequency: "monthly",
      termMonths: 12, includedVisitsPerTerm: 2,
    });
    const agreement = await agreements.sell(owner(), {
      planId: plan.id, customerId, propertyId, startedOn: "2026-01-15",
    });
    const [first] = await agreements.owed(owner(), { through: "2027-12-31" });
    const { job } = await agreements.book(owner(), { agreementVisitId: first!.visit.id });

    const resolved = await entitlements.forJob(owner(), { jobId: job.id });
    expect(resolved!.source).toBe("agreement");
    expect(resolved!.grantingEntityId).toBe(agreement.id);
  });

  it("does not overrule somebody who already decided", async () => {
    /**
     * The office knowing this is a warranty callback beats the system
     * knowing the customer has a plan. Driven through `resolveIn`, which is
     * what booking uses: an earlier version of this test set the row and
     * read it back, which proved nothing about the guard.
     */
    const job = await newJob("Already decided");
    await entitlements.resolve(owner(), { jobId: job.id, source: "our_warranty" });

    const ctx = owner();
    await inTenant(ctx, (tx) => entitlements.resolveIn(tx, ORG, {
      jobId: job.id, source: "agreement",
      grantingEntityType: "agreement", grantingEntityId: fixtureId("ent:fake"),
    }));

    expect((await entitlements.forJob(owner(), { jobId: job.id }))!.source).toBe("our_warranty");
    expect(await raw`select id from public.entitlement where job_id = ${job.id}`).toHaveLength(1);
  });

  it("writes one when nobody has decided", async () => {
    // The other half, so the test above cannot pass against a resolveIn
    // that never writes anything at all.
    const job = await newJob("Nobody decided");
    const ctx = owner();
    await inTenant(ctx, (tx) => entitlements.resolveIn(tx, ORG, {
      jobId: job.id, source: "agreement",
    }));
    expect((await entitlements.forJob(owner(), { jobId: job.id }))!.source).toBe("agreement");
  });
});
