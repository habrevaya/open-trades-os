import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { labor, ledger, type Actor } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import * as commissions from "../src/services/commissions";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A COMMISSION IS A LIABILITY THE MOMENT IT IS EARNED.
 *
 * The property this file is mostly about is that one. Everything else here is
 * downstream of it: if the earning does not post a liability, the company's
 * own accounts never show what it owes its technicians, the month a large
 * install lands reads as far more profitable than it was, and the expense
 * appears in whichever month somebody happened to run payroll.
 *
 * The second property is the reversal. A plan with no reversal is a plan under
 * which a company pays commission on money it never received: the customer
 * disputes the bill in April, the money goes back, and the technician keeps
 * eight per cent of a job nobody paid for.
 *
 * Every number below comes out of real invoices through the real services. A
 * row inserted to suit the answer proves nothing about the path a company
 * actually takes.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("commission:org");
const USER = fixtureId("commission:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** A role that holds commission:read and nothing that configures one. */
const reader = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["accountant"] as Actor["roles"] }, db: db(),
});

let technicianA = "";
let technicianB = "";
let technicianC = "";
let customerId = "";
let propertyId = "";

async function makeTechnician(name: string): Promise<string> {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  const [row] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membership!.id}, ${name}, 'Journeyman') returning id`;
  return row!.id;
}

/** A real job with a real invoice on it, through the real services. */
async function invoiceFor(
  total: string, opts: { technicianIds?: string[]; discount?: string } = {},
): Promise<{ invoiceId: string; jobId: string }> {
  const job = await jobs.create(owner(), {
    customerId, propertyId,
    summary: "Condenser replacement",
    tags: [], customFields: {},
    visit: {
      windowStart: "2026-02-03T14:00:00.000Z",
      windowEnd: "2026-02-03T18:00:00.000Z",
      estimatedDurationMinutes: 240,
      technicianIds: opts.technicianIds ?? [],
    },
  });

  const invoice = await billing.create(owner(), {
    customerId,
    jobId: job.id as string,
    lines: [{
      name: "Condenser", quantity: "1", unitPrice: total,
      discountAmount: opts.discount ?? "0", taxable: false,
    }],
  });

  return { invoiceId: invoice.id as string, jobId: job.id as string };
}

/** Net movement on an account. Debits positive, so a liability reads negative. */
async function accountBalance(account: string): Promise<string> {
  const [row] = await raw`
    select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::numeric(14,4)::text as net
    from public.ledger_entry where organization_id = ${ORG} and account_code = ${account}`;
  return (row as { net: string }).net;
}

async function plan(over: Partial<commissions.PlanInput> = {}) {
  return commissions.declarePlan(owner(), {
    label: over.label ?? "Service, eight per cent of revenue",
    basis: over.basis ?? "percent_of_revenue",
    note: over.note ?? "Eight per cent of what the job invoiced for, net of tax.",
    ...(over.rate !== undefined ? { rate: over.rate } : { rate: "0.08" }),
    ...(over.flatAmount !== undefined ? { flatAmount: over.flatAmount } : {}),
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Commission Co", slug: "commission-co" });

  technicianA = await makeTechnician("Ray Nunez");
  technicianB = await makeTechnician("Dana Pike");
  technicianC = await makeTechnician("Ola Marsh");

  const created = await customers.create(owner(), {
    type: "residential", name: "Delacroix", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
  });
  customerId = created.id as string;
  const [prop] = await raw`select id from public.property where organization_id = ${ORG}`;
  propertyId = (prop as { id: string }).id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.commission_entry where organization_id = ${ORG}`;
  await raw`delete from public.commission_reversal where organization_id = ${ORG}`;
  await raw`delete from public.commission_event where organization_id = ${ORG}`;
  await raw`delete from public.commission_plan where organization_id = ${ORG}`;
  await raw`set session_replication_role = replica`;
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw`set session_replication_role = origin`;
  await raw`delete from public.job_line where organization_id = ${ORG}`;
  await raw`delete from public.timeclock_entry where organization_id = ${ORG}`;
});

/* ========================================================== the catalogue */

run("the basis a company picks", () => {
  it("is the same four in the database as in core", () => {
    /**
     * Two copies of a list disagree eventually. The enum constrains the column
     * and core carries the meaning, and a basis in one and not the other is
     * either an option every save rejects or a stored value nothing can price.
     */
    expect([...schema.commissionBasis.enumValues].sort())
      .toEqual([...labor.COMMISSION_BASES].sort());
  });

  it("publishes what each one is wrong about", async () => {
    /**
     * A commission plan is the most powerful instruction a contractor ever
     * gives a technician, and it is usually given in about ninety seconds. The
     * sentence that would change their mind has to be on the screen where the
     * choice is made, not in a help article.
     */
    const published = await commissions.bases(reader());
    expect(published).toHaveLength(4);
    for (const basis of published) {
      expect(basis.wrongAbout.length, basis.key).toBeGreaterThan(80);
    }
    expect(published.find((b) => b.key === "percent_of_revenue")!.wrongAbout)
      .toMatch(/expensive option/i);
  });

  it("refuses a plan with no note, because core refuses to compute under one", async () => {
    await expect(plan({ note: "   " })).rejects.toThrow(/note/i);
  });

  it("refuses a percentage plan with no rate and a flat plan with no amount", async () => {
    await expect(plan({ rate: null })).rejects.toThrow(/needs a rate/i);
    await expect(plan({ basis: "flat_per_job", rate: null })).rejects.toThrow(/amount per job/i);
  });

  it("refuses a rate of zero rather than storing a plan that pays nothing", async () => {
    await expect(plan({ rate: "0" })).rejects.toThrow(/not a plan/i);
  });

  it("carries the caveat on every plan it returns", async () => {
    await plan();
    const [stored] = await commissions.plans(reader());
    expect(stored!.wrongAbout).toMatch(/expensive option/i);
  });
});

/* ============================================================== the earning */

run("earning a commission", () => {
  it("posts an expense and a liability, and nothing else", async () => {
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00");

    const earned = await commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [{ technicianId: technicianA, weight: "1" }],
    });

    expect(earned.total).toBe("80.0000");

    /**
     * THE ASSERTION THIS WHOLE FILE EXISTS FOR. The company owes eighty
     * dollars. It has not paid it and will not until payroll runs, and if it
     * shut its doors this afternoon it would still owe it.
     */
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_EXPENSE)).toBe("80.0000");
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-80.0000");

    /** No cash moved. Nobody has been paid. */
    const [cash] = await raw`select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and account_code = ${ledger.ACCOUNTS.CASH}
        and source_type = 'commission'`;
    expect((cash as { n: number }).n).toBe(0);
  });

  it("takes revenue net of tax and of discount, not the invoice total", async () => {
    /**
     * Commission on the tax line is a share of money owed to a jurisdiction,
     * and the discount is revenue the company never earned. `postInvoice`
     * credits revenue with the subtotal and debits contra revenue with the
     * discount, so what the company earned on the document is the difference,
     * and the commission has to agree with the ledger rather than with the
     * headline figure the customer pays.
     *
     * THE TAX IS PUT ON THE ROW DIRECTLY, and that is the only way to write
     * this test today: `billing.create` hard codes a tax rate of zero with a
     * comment saying rates are resolved per jurisdiction in a later phase, so
     * no invoice this product can issue carries tax yet. Without a taxed
     * invoice, `total` and `subtotal - discount` are the same number and the
     * assertion cannot tell a correct implementation from one taking the
     * total, which is exactly the shape this file is supposed to catch.
     */
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00", { discount: "200.00" });
    await raw`update public.invoice
      set tax_total = '66.0000', total = '866.0000', balance = '866.0000'
      where id = ${invoiceId}`;

    const earned = await commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [{ technicianId: technicianA, weight: "1" }],
    });

    expect(earned.revenue).toBe("800.0000");
    expect(earned.total).toBe("64.0000");
  });

  it("splits by weight and the parts add back to the whole exactly", async () => {
    const declared = await plan({ rate: "0.10" });
    const { invoiceId } = await invoiceFor("1000.00");

    const earned = await commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [
        { technicianId: technicianA, weight: "1" },
        { technicianId: technicianB, weight: "1" },
        { technicianId: technicianC, weight: "1" },
      ],
    });

    /**
     * A hundred dollars three ways is $33.333... and there is no such coin.
     * Dividing and rounding each third gives $99.99 or $100.02, and the
     * liability account is out by a cent on that job and on every job like it,
     * forever. `money.allocate` hands the odd cent to one of them
     * deterministically and the parts add back exactly, which is the only
     * property that makes a payroll reconcile.
     */
    const parts = earned.parts.map((part) => Number(part.amount));
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(parts.filter((p) => p === 33.34)).toHaveLength(1);
    expect(parts.filter((p) => p === 33.33)).toHaveLength(2);

    /** And the ledger carries the whole, not the sum of three roundings. */
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-100.0000");
  });

  it("splits evenly between the technicians on the job when nobody says otherwise", async () => {
    const declared = await plan({ rate: "0.10" });
    const { invoiceId } = await invoiceFor("600.00", { technicianIds: [technicianA, technicianB] });

    const earned = await commissions.settle(owner(), { invoiceId, planId: declared.id });

    expect(earned.parts).toHaveLength(2);
    expect(earned.parts.map((p) => p.amount).sort()).toEqual(["30.0000", "30.0000"]);
  });

  it("refuses to settle the same invoice twice", async () => {
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00");
    const shares = [{ technicianId: technicianA, weight: "1" }];

    await commissions.settle(owner(), { invoiceId, planId: declared.id, shares });
    await expect(commissions.settle(owner(), { invoiceId, planId: declared.id, shares }))
      .rejects.toThrow(/already earned/i);

    /** And the liability did not double. */
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-80.0000");
  });

  it("works for a company that has never declared an overtime policy", async () => {
    /**
     * Commission has nothing to do with overtime. The check that refuses
     * backdating into a closed pay period resolves the policy to derive the
     * period's bounds, and resolving it unconditionally made `policyFor`'s
     * refusal reach a company that pays commission and has nobody on the
     * clock: they could not settle one at all, and the error they got talked
     * about timesheets.
     */
    await raw`delete from public.overtime_policy where organization_id = ${ORG}`;
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00");
    const earned = await commissions.settle(owner(), {
      invoiceId, planId: declared.id, shares: [{ technicianId: technicianA, weight: "1" }],
    });
    expect(earned.total).toBe("80.0000");
  });

  it("refuses an invoice that is void or written off", async () => {
    const declared = await plan();
    const shares = [{ technicianId: technicianA, weight: "1" }];

    const voided = await invoiceFor("500.00");
    await billing.voidInvoice(owner(), { id: voided.invoiceId, reason: "Billed the wrong customer" });
    await expect(commissions.settle(owner(), { invoiceId: voided.invoiceId, planId: declared.id, shares }))
      .rejects.toThrow(/never paid for/i);

    const bad = await invoiceFor("500.00");
    await billing.writeOff(owner(), { id: bad.invoiceId, reason: "Gone to collections and lost" });
    await expect(commissions.settle(owner(), { invoiceId: bad.invoiceId, planId: declared.id, shares }))
      .rejects.toThrow(/never paid for/i);
  });

  it("refuses when two plans are active and nobody said which", async () => {
    await plan({ label: "Install" });
    await plan({ label: "Service" });
    const { invoiceId } = await invoiceFor("1000.00");

    /**
     * Two active plans is a normal thing to have, one for installers and one
     * for service. Picking the first pays somebody under the wrong one and
     * nothing on the screen says so.
     */
    await expect(commissions.settle(owner(), {
      invoiceId, shares: [{ technicianId: technicianA, weight: "1" }],
    })).rejects.toThrow(/Name which one/i);
  });

  it("refuses a split that names the same person twice", async () => {
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00");

    /**
     * The weights still sum to the whole, so the commission total is right and
     * one person's share of it is doubled. Nothing downstream can see it.
     */
    await expect(commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [
        { technicianId: technicianA, weight: "1" },
        { technicianId: technicianA, weight: "1" },
      ],
    })).rejects.toThrow(/twice/i);
  });

  it("refuses a split of zeros rather than throwing out of money.allocate", async () => {
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00");
    await expect(commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [{ technicianId: technicianA, weight: "0" }, { technicianId: technicianB, weight: "0" }],
    })).rejects.toThrow(/nothing to divide/i);
  });

  it("refuses a technician who is not in this company", async () => {
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00");
    await expect(commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [{ technicianId: fixtureId("commission:stranger"), weight: "1" }],
    })).rejects.toThrow(NotFoundError);
  });
});

/* ========================================================= the other bases */

run("a plan that pays on what was collected", () => {
  it("refuses until the invoice is paid in full", async () => {
    const declared = await plan({
      basis: "percent_of_collected", rate: "0.08",
      note: "Eight per cent of the cash that actually arrived.",
    });
    const { invoiceId } = await invoiceFor("1000.00");
    const shares = [{ technicianId: technicianA, weight: "1" }];

    await expect(commissions.settle(owner(), { invoiceId, planId: declared.id, shares }))
      .rejects.toThrow(/paid in full/i);

    /** Part payment is still not the moment. */
    await billing.pay(owner(), {
      customerId, method: "card", amount: "400.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "400.00" }],
    });
    await expect(commissions.settle(owner(), { invoiceId, planId: declared.id, shares }))
      .rejects.toThrow(/paid in full/i);

    await billing.pay(owner(), {
      customerId, method: "card", amount: "600.00", tipAmount: "0",
      allocations: [{ invoiceId, amount: "600.00" }],
    });
    const earned = await commissions.settle(owner(), { invoiceId, planId: declared.id, shares });
    expect(earned.total).toBe("80.0000");
  });
});

run("a plan that pays on margin", () => {
  async function costTheJob(jobId: string, unitCost: string | null) {
    await raw`insert into public.job_line
      (organization_id, job_id, kind, name, quantity, unit_price, unit_cost)
      values (${ORG}, ${jobId}, 'part', 'Condenser unit', '1', '1000.00', ${unitCost})`;
  }

  const marginPlan = () => plan({
    basis: "percent_of_gross_margin", rate: "0.20",
    note: "A fifth of what the job made after what it cost us.",
  });

  it("refuses when the job has no cost recorded, rather than assuming zero", async () => {
    /**
     * Treating an unknown cost as zero pays commission on the whole invoice as
     * though none of it cost anything, which is the most expensive default
     * available and the one every spreadsheet has.
     */
    const declared = await marginPlan();
    const { invoiceId } = await invoiceFor("1000.00");
    await expect(commissions.settle(owner(), {
      invoiceId, planId: declared.id, shares: [{ technicianId: technicianA, weight: "1" }],
    })).rejects.toThrow(/no cost recorded/i);
  });

  it("refuses when only part of the job is costed", async () => {
    /**
     * A partial cost makes the job look more profitable than it was and
     * overpays by exactly the share of the missing cost. Nothing about the
     * number says it is incomplete, which is the whole reason this returns
     * nothing rather than a smaller figure.
     */
    const declared = await marginPlan();
    const { invoiceId, jobId } = await invoiceFor("1000.00");
    await costTheJob(jobId, "600.00");
    await costTheJob(jobId, null);

    await expect(commissions.settle(owner(), {
      invoiceId, planId: declared.id, shares: [{ technicianId: technicianA, weight: "1" }],
    })).rejects.toThrow(/no cost recorded/i);
  });

  it("pays on the margin once the cost is there", async () => {
    const declared = await marginPlan();
    const { invoiceId, jobId } = await invoiceFor("1000.00");
    await costTheJob(jobId, "600.00");

    const earned = await commissions.settle(owner(), {
      invoiceId, planId: declared.id, shares: [{ technicianId: technicianA, weight: "1" }],
    });
    expect(earned.cost).toBe("600.0000");
    expect(earned.total).toBe("80.0000");
  });

  it("counts the labour on the job at the loaded rate, not the base one", async () => {
    /**
     * What the hours COST the company is base plus fringe. The payroll export
     * pays the base rate, because the fringe is a contribution to a fund; job
     * costing uses the loaded rate, because the company paid both. Using the
     * same number for each is wrong in one direction or the other every time.
     */
    const declared = await marginPlan();
    const { invoiceId, jobId } = await invoiceFor("1000.00");
    await costTheJob(jobId, "400.00");
    await raw`insert into public.timeclock_entry
      (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes,
       applied_base_rate, applied_fringe_rate, applied_loaded_rate)
      values (${ORG}, ${technicianA}, ${jobId}, 'on_site',
              '2026-02-03T14:00:00Z', '2026-02-03T18:00:00Z', 240,
              '40.0000', '8.0000', '48.0000')`;

    const earned = await commissions.settle(owner(), {
      invoiceId, planId: declared.id, shares: [{ technicianId: technicianA, weight: "1" }],
    });
    /** 400 of parts plus four hours at 48 is 592, so the margin is 408. */
    expect(earned.cost).toBe("592.0000");
    expect(earned.total).toBe("81.6000");
  });

  it("refuses while a punch on the job is still open", async () => {
    const declared = await marginPlan();
    const { invoiceId, jobId } = await invoiceFor("1000.00");
    await costTheJob(jobId, "400.00");
    /**
     * The rate IS frozen on this one, so the refusal under test is the open
     * punch rather than the missing rate. An entry in that state is what a
     * corrected punch looks like between somebody reopening it and closing it
     * at the right time.
     */
    await raw`insert into public.timeclock_entry
      (organization_id, technician_id, job_id, kind, started_at,
       applied_base_rate, applied_loaded_rate)
      values (${ORG}, ${technicianA}, ${jobId}, 'on_site', '2026-02-03T14:00:00Z',
              '40.0000', '48.0000')`;

    /**
     * An open punch is an unknown number of hours. Costing it at the minutes
     * recorded so far, which is none, understates the job by however long the
     * technician is still standing there.
     */
    await expect(commissions.settle(owner(), {
      invoiceId, planId: declared.id, shares: [{ technicianId: technicianA, weight: "1" }],
    })).rejects.toThrow(/no cost recorded/i);
  });
});

/* ============================================================== reversals */

run("taking a commission back off", () => {
  async function earned(total = "1000.00", rate = "0.08") {
    const declared = await plan({ rate });
    const { invoiceId, jobId } = await invoiceFor(total);
    const event = await commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [
        { technicianId: technicianA, weight: "3" },
        { technicianId: technicianB, weight: "1" },
      ],
    });
    return { invoiceId, jobId, event, planId: declared.id };
  }

  it("clears the liability when the whole invoice is written off", async () => {
    const { invoiceId } = await earned();
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-80.0000");

    const reversal = await commissions.reverse(owner(), {
      invoiceId, reason: "write_off", creditedRevenue: "1000.00",
      causeType: "invoice.written_off", causeId: invoiceId,
    });

    expect(reversal.total).toBe("-80.0000");
    /**
     * Back to nothing. The company was never paid for the work, so it never
     * owed the commission, and the expense it recognised comes back off too.
     */
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("0.0000");
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_EXPENSE)).toBe("0.0000");
  });

  it("takes back each person's own share, and the shares still add up", async () => {
    const { invoiceId } = await earned();
    const reversal = await commissions.reverse(owner(), {
      invoiceId, reason: "refund", creditedRevenue: "500.00",
      causeType: "payment.refunded", causeId: fixtureId("commission:refund-1"),
    });

    /** Sixty and twenty becomes thirty and ten, so thirty and ten come back. */
    const byPerson = new Map(reversal.lines.map((line) => [line.technicianId, line.amount]));
    expect(byPerson.get(technicianA)).toBe("-30.0000");
    expect(byPerson.get(technicianB)).toBe("-10.0000");
    expect(reversal.total).toBe("-40.0000");
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-40.0000");
  });

  it("gives each person back exactly their own part, odd cent included", async () => {
    /**
     * THE ODD CENT HAS TO COME BACK OFF THE PERSON IT WENT TO.
     *
     * A hundred dollars three ways is 33.34, 33.33 and 33.33, and
     * `money.allocate` decides which of them gets the extra cent by POSITION.
     * A reversal recomputes the whole split and differences it per person, so
     * it has to hand core the shares in the order they were handed over the
     * first time. Reading them back in any other order, by an id that is
     * random or a created_at that ties inside one transaction, moves the cent
     * between two technicians: one of them gives back a cent they were never
     * paid, the other keeps one, and the parts stop adding back to the whole.
     */
    const declared = await plan({ rate: "0.10" });
    const { invoiceId } = await invoiceFor("1000.00");
    const event = await commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [
        { technicianId: technicianA, weight: "1" },
        { technicianId: technicianB, weight: "1" },
        { technicianId: technicianC, weight: "1" },
      ],
    });

    const reversal = await commissions.reverse(owner(), {
      invoiceId, reason: "write_off", creditedRevenue: "1000.00",
      causeType: "invoice.written_off", causeId: invoiceId,
    });

    const earnedBy = new Map(event.parts.map((part) => [part.technicianId, Number(part.amount)]));
    const backFrom = new Map(reversal.lines.map((line) => [line.technicianId, Number(line.amount)]));
    for (const [technicianId, amount] of earnedBy) {
      expect(backFrom.get(technicianId), technicianId).toBe(-amount);
    }
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("0.0000");
  });

  it("REFUSES to credit more than the commission was earned on", async () => {
    /**
     * THE GUARD THAT LOOKS FINE UNTIL THE DAY IT MATTERS. Without it a
     * repeated or mistyped credit drives the liability negative, and a
     * technician ends up owing the company money for a job they were paid for
     * once. Nothing downstream can tell a negative liability from a clerical
     * error, because both are just a number.
     */
    const { invoiceId } = await earned();
    await expect(commissions.reverse(owner(), {
      invoiceId, reason: "write_off", creditedRevenue: "1500.00",
      causeType: "invoice.written_off", causeId: invoiceId,
    })).rejects.toThrow(/cannot take back more than was earned/i);

    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-80.0000");
  });

  it("refuses the same cause twice, so a retry does not take the money off again", async () => {
    const { invoiceId } = await earned();
    const cause = fixtureId("commission:cause-dup");

    await commissions.reverse(owner(), {
      invoiceId, reason: "credit_note", creditedRevenue: "250.00",
      causeType: "credit_note.issued", causeId: cause,
    });
    await expect(commissions.reverse(owner(), {
      invoiceId, reason: "credit_note", creditedRevenue: "250.00",
      causeType: "credit_note.issued", causeId: cause,
    })).rejects.toThrow(/already been reversed/i);

    /** One credit, one reversal: eighty less twenty. */
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("-60.0000");
  });

  it("nets two partial credits against the cumulative position, never the pristine original", async () => {
    /**
     * Applying each credit to the original and taking the difference is right
     * for a plain percentage and silently wrong for anything with a floor, a
     * tier or a margin, because those are not linear in the credit. So the
     * commission is recomputed as though the cumulative credit had always
     * applied, and what has already come back is subtracted from that. The
     * test of it is that two halves land exactly where one whole would.
     */
    const { invoiceId } = await earned();

    await commissions.reverse(owner(), {
      invoiceId, reason: "refund", creditedRevenue: "500.00",
      causeType: "payment.refunded", causeId: fixtureId("commission:half-1"),
    });
    const second = await commissions.reverse(owner(), {
      invoiceId, reason: "refund", creditedRevenue: "500.00",
      causeType: "payment.refunded", causeId: fixtureId("commission:half-2"),
    });

    expect(second.total).toBe("-40.0000");
    expect(await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE)).toBe("0.0000");

    /** And the cap still holds after the two halves have used it all up. */
    await expect(commissions.reverse(owner(), {
      invoiceId, reason: "refund", creditedRevenue: "0.01",
      causeType: "payment.refunded", causeId: fixtureId("commission:half-3"),
    })).rejects.toThrow(/cannot take back more than was earned/i);
  });

  it("recomputes under the plan the commission was earned under, not today's", async () => {
    /**
     * The plan is superseded, not edited, but a reversal that looked up the
     * company's current plan would still take back an amount nobody was ever
     * paid. The basis and the rate are frozen on the event for the same reason
     * the wage is frozen on a punch.
     */
    const { invoiceId, planId } = await earned("1000.00", "0.08");
    await commissions.deactivatePlan(owner(), { id: planId });
    await plan({ label: "This year", rate: "0.02" });

    const reversal = await commissions.reverse(owner(), {
      invoiceId, reason: "write_off", creditedRevenue: "1000.00",
      causeType: "invoice.written_off", causeId: invoiceId,
    });
    expect(reversal.total).toBe("-80.0000");
  });

  it("refuses a reversal of nothing", async () => {
    const { invoiceId } = await earned();
    await expect(commissions.reverse(owner(), {
      invoiceId, reason: "refund", creditedRevenue: "0",
      causeType: "payment.refunded", causeId: fixtureId("commission:zero"),
    })).rejects.toThrow(ConflictError);
  });

  it("has nothing to reverse on an invoice that never earned one", async () => {
    const { invoiceId } = await invoiceFor("100.00");
    await expect(commissions.reverse(owner(), {
      invoiceId, reason: "refund", creditedRevenue: "10.00",
      causeType: "payment.refunded", causeId: fixtureId("commission:none"),
    })).rejects.toThrow(NotFoundError);
  });
});

/* ============================================================== the reads */

run("what is owed", () => {
  it("agrees with the commission payable balance in the ledger", async () => {
    /**
     * Computed from different rows by different code. That is the only way the
     * agreement means anything: a figure derived from the same query it is
     * checked against proves nothing at all.
     */
    const declared = await plan();
    const first = await invoiceFor("1000.00");
    const second = await invoiceFor("2500.00");

    await commissions.settle(owner(), {
      invoiceId: first.invoiceId, planId: declared.id,
      shares: [{ technicianId: technicianA, weight: "1" }],
    });
    await commissions.settle(owner(), {
      invoiceId: second.invoiceId, planId: declared.id,
      shares: [{ technicianId: technicianA, weight: "1" }, { technicianId: technicianB, weight: "1" }],
    });
    await commissions.reverse(owner(), {
      invoiceId: first.invoiceId, reason: "callback", creditedRevenue: "400.00",
      causeType: "callback.credited", causeId: fixtureId("commission:callback"),
    });

    const read = await commissions.earnings(reader(), {});
    const payable = await accountBalance(ledger.ACCOUNTS.COMMISSION_PAYABLE);

    expect(read.owed).toBe("248.0000");
    expect(Number(read.owed)).toBeCloseTo(-Number(payable), 10);
  });

  it("filters to one person without leaking the rest", async () => {
    const declared = await plan();
    const { invoiceId } = await invoiceFor("1000.00");
    await commissions.settle(owner(), {
      invoiceId, planId: declared.id,
      shares: [{ technicianId: technicianA, weight: "1" }, { technicianId: technicianB, weight: "1" }],
    });

    const mine = await commissions.earnings(reader(), { technicianId: technicianA });
    expect(mine.entries).toHaveLength(1);
    expect(mine.net).toBe("40.0000");
  });
});
