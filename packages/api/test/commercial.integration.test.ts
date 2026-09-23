import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as commercial from "../src/services/commercial";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE COMMERCIAL ARRANGEMENT
 *
 * The product assumed ONE customer who owns the property, approves the work,
 * receives the invoice and pays it. That is true for residential service and
 * false for roughly half the market: a property manager orders, a tenant is
 * on site, an owner pays; a facilities network authorises a ceiling and
 * disputes anything above it.
 *
 * The tables were written in the first migrations and reached by nothing.
 * These tests are about the two things that decide whether a contractor gets
 * paid: WHO the invoice goes to, and the CEILING they authorised.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cm:org");
const USER = fixtureId("cm:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** The tenant who is on site, and the manager who pays. */
let tenantId = "";
let managerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Commercial Co", slug: "commercial-co" });

  const tenant = await customers.create(owner(), {
    type: "residential", name: "Tess Tenant", phone: "+15125550122",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  tenantId = tenant.id;
  const manager = await customers.create(owner(), {
    type: "commercial", name: "Meridian Property Management", phone: "+15125550133",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  managerId = manager.id;

  const property = await properties.create(owner(), {
    address: { line1: "12 Commerce St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: tenantId, customerRole: "owner",
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
  await raw`delete from public.authorization where organization_id = ${ORG}`;
  await raw`delete from public.job_party where organization_id = ${ORG}`;
  await raw`delete from public.entitlement where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
});

const newJob = async () => jobs.create(owner(), {
  customerId: tenantId, propertyId, summary: "Commercial job", tags: [], customFields: {},
});

const line = (unitPrice: string) => ({
  name: "Labour, 4 hours", quantity: "1", unitPrice,
  discountAmount: "0", taxable: false,
});

run("who is actually involved", () => {
  it("records the whole cast", async () => {
    const job = await newJob();
    await commercial.setParties(owner(), {
      jobId: job.id,
      parties: [
        { role: "requester", customerId: managerId },
        { role: "site_contact", customerId: tenantId },
        { role: "bill_to", customerId: managerId },
      ],
    });
    const rows = await commercial.parties(owner(), { jobId: job.id });
    expect(rows.map((r) => r.party.role).sort()).toEqual(["bill_to", "requester", "site_contact"]);
  });

  it("replaces the cast rather than merging it", async () => {
    // "Who is involved in this job" has one answer, and a merge leaves
    // whoever used to be the approver still holding the role.
    const job = await newJob();
    await commercial.setParties(owner(), {
      jobId: job.id, parties: [{ role: "approver", customerId: managerId }],
    });
    await commercial.setParties(owner(), {
      jobId: job.id, parties: [{ role: "approver", customerId: tenantId }],
    });
    const rows = await commercial.parties(owner(), { jobId: job.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.party.customerId).toBe(tenantId);
  });

  it("refuses a role nobody holds", async () => {
    /**
     * A party with nothing in it reads on the screen as somebody being
     * responsible, which is worse than the role being absent.
     */
    const job = await newJob();
    await expect(commercial.setParties(owner(), {
      jobId: job.id, parties: [{ role: "approver" }],
    })).rejects.toThrow(/needs a name or a record/);
  });

  it("refuses two parties being billed", async () => {
    // Two bill-to parties is two invoices somebody has to decide between,
    // and a split is a share on each rather than two of the role.
    const job = await newJob();
    await expect(commercial.setParties(owner(), {
      jobId: job.id,
      parties: [
        { role: "bill_to", customerId: managerId },
        { role: "bill_to", customerId: tenantId },
      ],
    })).rejects.toThrow(/one party/);
  });

  it("takes a party with no record of their own", async () => {
    // "ABC Warranty, claim 44812" is a party we never bill and never store.
    const job = await newJob();
    const rows = await commercial.setParties(owner(), {
      jobId: job.id,
      parties: [{ role: "approver", externalName: "ABC Warranty", externalReference: "44812" }],
    });
    expect(rows[0]!.externalReference).toBe("44812");
  });
});

run("the invoice goes to whoever is being billed", () => {
  it("refuses an invoice addressed to the person on site", async () => {
    /**
     * A property manager orders the work, a tenant is there, an owner pays.
     * An invoice addressed to the tenant is a document the payer will not
     * accept and the tenant should never have seen.
     */
    const job = await newJob();
    await commercial.setParties(owner(), {
      jobId: job.id,
      parties: [
        { role: "site_contact", customerId: tenantId },
        { role: "bill_to", customerId: managerId },
      ],
    });

    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("400.00")],
    })).rejects.toThrow(/Meridian Property Management/);
  });

  it("allows the one addressed to the payer", async () => {
    const job = await newJob();
    await commercial.setParties(owner(), {
      jobId: job.id, parties: [{ role: "bill_to", customerId: managerId }],
    });
    const invoice = await billing.create(owner(), {
      customerId: managerId, jobId: job.id, lines: [line("400.00")],
    });
    expect(invoice.customerId).toBe(managerId);
  });

  it("leaves the residential case exactly as it was", async () => {
    /**
     * The test a change like this has to pass. A job with no parties named
     * is one customer holding every role, and nothing about it gets harder.
     */
    const job = await newJob();
    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("400.00")],
    })).resolves.toBeTruthy();
  });
});

run("the ceiling", () => {
  it("allows an invoice that fits", async () => {
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: "500.00", grantedByName: "Meridian" });
    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("400.00")],
    })).resolves.toBeTruthy();
  });

  it("reads back who granted it, because the screen edits that box", async () => {
    /**
     * Raising a ceiling supersedes rather than updates, so the form is
     * repopulated from this and posted back whole. A read that leaves the
     * name out does not lose it on the way in: it shows an empty box, and
     * the next person to touch the amount saves a blank over whoever
     * actually authorised the work.
     */
    const job = await newJob();
    await commercial.authorize(owner(), {
      jobId: job.id, amount: "500.00", grantedByName: "Meridian, Dana", externalReference: "PO 44812",
    });

    const state = await commercial.authorizationFor(owner(), { jobId: job.id });
    expect(state!.grantedByName).toBe("Meridian, Dana");
    expect(state!.externalReference).toBe("PO 44812");
  });

  it("refuses one that goes over, and says what would fit", async () => {
    /**
     * The network pays five hundred and disputes the rest. The four hundred
     * is not a receivable, it is a write-off, and nobody notices until the
     * aging report has a column of them.
     */
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: "500.00" });
    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("900.00")],
    })).rejects.toThrow(/500\.0000/);
  });

  it("counts what an earlier invoice already used", async () => {
    // The case that is usually got wrong: each invoice fits on its own and
    // together they do not.
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: "500.00" });
    await billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("300.00")],
    });

    const state = await commercial.authorizationFor(owner(), { jobId: job.id });
    expect(state!.consumed).toBe("300.0000");
    expect(state!.remaining).toBe("200.0000");

    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("300.00")],
    })).rejects.toThrow(ConflictError);
  });

  it("records which authorisation governed the invoice", async () => {
    /**
     * `invoice.authorization_id` carries the comment "Set when a ceiling
     * governs this invoice, so a breach is checkable", and nothing set it.
     *
     * The ceiling itself was enforced all along, so this is narrower than it
     * sounds: no invoice was ever billed over its limit. What was missing is
     * the itemisation. `authorization.consumed_amount` is a running total
     * with nothing behind it, so a commercial client asking which invoices
     * ate their five hundred dollars had to be answered by matching job ids
     * and dates by hand.
     */
    const job = await newJob();
    const granted = await commercial.authorize(owner(), { jobId: job.id, amount: "500.00" });
    const invoice = await billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("120.00")],
    });

    const [row] = await raw<{ authorization_id: string | null }[]>`
      select authorization_id from public.invoice where id = ${invoice.id}`;
    expect(row!.authorization_id).toBe(granted.id);
  });

  it("leaves it null on an invoice no ceiling governs", async () => {
    // A residential job has no authorisation, and pointing at one would be a
    // worse lie than pointing at nothing.
    const job = await newJob();
    const invoice = await billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("120.00")],
    });

    const [row] = await raw<{ authorization_id: string | null }[]>`
      select authorization_id from public.invoice where id = ${invoice.id}`;
    expect(row!.authorization_id).toBeNull();
  });

  it("refuses when the authorisation was denied", async () => {
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: "500.00" });
    await commercial.deny(owner(), { jobId: job.id, reason: "Out of scope" });
    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("100.00")],
    })).rejects.toThrow(/not authorised/);
  });

  it("refuses when the authorisation has expired", async () => {
    // An authorisation with a date on it is a client saying "this week".
    const job = await newJob();
    await commercial.authorize(owner(), {
      jobId: job.id, amount: "500.00", expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("100.00")],
    })).rejects.toThrow(/expired/);
  });

  it("allows anything under an authorisation with no stated limit", async () => {
    // "Approved, bill what it costs" is a real answer a client gives.
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: null });
    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("9000.00")],
    })).resolves.toBeTruthy();
  });

  it("leaves a job nobody authorised alone", async () => {
    // This is a ceiling, not a permission system. A residential job has
    // nobody to authorise it.
    const job = await newJob();
    await expect(billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("9000.00")],
    })).resolves.toBeTruthy();
  });
});

run("raising the ceiling", () => {
  it("supersedes the old one rather than sitting beside it", async () => {
    // Two live ceilings is two answers to "how much may we bill", and every
    // reader would have to pick.
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: "500.00" });
    await commercial.authorize(owner(), { jobId: job.id, amount: "1200.00", scopeNotes: "Supplement" });

    const live = await raw`select id from public.authorization
                           where job_id = ${job.id} and state = 'granted'`;
    expect(live).toHaveLength(1);
    expect((await commercial.authorizationFor(owner(), { jobId: job.id }))!.amount).toBe("1200.0000");
  });

  it("carries what is already billed across the supplement", async () => {
    /**
     * Resetting it would let a client who authorised five hundred, then
     * another five hundred after three hundred was billed, be invoiced
     * thirteen hundred.
     */
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: "500.00" });
    await billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("300.00")],
    });
    await commercial.authorize(owner(), { jobId: job.id, amount: "1000.00" });

    const state = await commercial.authorizationFor(owner(), { jobId: job.id });
    expect(state!.consumed).toBe("300.0000");
    expect(state!.remaining).toBe("700.0000");
  });

  it("records that we went over rather than losing it", async () => {
    /**
     * Some networks allow the overage and chase it afterwards. Recording it
     * is what makes "how often do we go over, and with whom" a question with
     * an answer.
     */
    const job = await newJob();
    await commercial.authorize(owner(), { jobId: job.id, amount: null });
    await billing.create(owner(), {
      customerId: tenantId, jobId: job.id, lines: [line("400.00")],
    });
    // Tighten the ceiling below what is already billed, the way a client
    // revising an approval downwards does.
    await raw`update public.authorization set amount = '300.0000'
              where job_id = ${job.id} and state = 'granted'`;

    const list = await commercial.ceilings(owner());
    const found = list.find((r) => r.authorization.jobId === job.id);
    expect(found!.authorization.consumedAmount).toBe("400.0000");
  });
});

run("the two ways an invoice ends without being paid", () => {
  /**
   * `invoice_status` has carried `void` and `written_off` since it was
   * written, the contract published both, `invoice:writeoff` was a permission
   * in the catalogue, and `ledger.postWriteOff` was written and tested.
   * Nothing could reach any of it: no route, no service, no path.
   * `invoice.voided_at` was a column nothing wrote.
   *
   * So the only way to deal with an invoice that was never going to be paid
   * was to leave it open. Receivables aged past a year, the AR report kept
   * counting money that did not exist, and the workaround was the database.
   */
  const invoiceRow = (id: string) => raw<{
    status: string; balance: string; voided_at: Date | null;
  }[]>`select status, balance, voided_at from public.invoice where id = ${id}`;

  /**
   * Signed, because the amount column is always positive and the direction
   * says which way. Netting the raw amounts is how the first version of the
   * reversal test concluded that a voided invoice had doubled its receivable.
   */
  const postingsFor = (id: string) => raw<{ account: string; signed: number }[]>`
    select account_code as account,
           case when direction = 'debit' then amount else -amount end as signed
    from public.ledger_entry
    where organization_id = ${ORG} and source_id = ${id} order by account_code`;

  async function anInvoice(): Promise<{ id: string; total: string }> {
    const invoice = await billing.create(owner(), {
      customerId: tenantId, lines: [line("400.00")],
    });
    return { id: invoice.id, total: invoice.total };
  }

  it("voids an invoice that should never have been raised", async () => {
    const { id } = await anInvoice();
    await billing.voidInvoice(owner(), { id, reason: "Raised against the wrong property" });

    const [row] = await invoiceRow(id);
    expect(row!.status).toBe("void");
    // The column that nothing used to write.
    expect(row!.voided_at).not.toBeNull();
    // Nothing is owed, so nothing should still be counted.
    expect(Number(row!.balance)).toBe(0);
  });

  it("reverses the original posting rather than moving the balance", async () => {
    /**
     * A void says the invoice should never have existed, so the revenue was
     * never earned and the tax was never collected. Treating it as a write
     * off would leave revenue the company never earned on its books and a bad
     * debt expense it never suffered, and a tax return is built on both.
     */
    const { id } = await anInvoice();
    const before = await postingsFor(id);
    await billing.voidInvoice(owner(), { id, reason: "Duplicate" });
    const after = await postingsFor(id);

    expect(after.length).toBeGreaterThan(before.length);
    // Every account nets to zero once the reversal is in.
    const net = new Map<string, number>();
    for (const entry of after) {
      net.set(entry.account, (net.get(entry.account) ?? 0) + Number(entry.signed));
    }
    for (const [account, sum] of net) {
      expect([account, Math.round(sum * 10000)]).toEqual([account, 0]);
    }
  });

  it("refuses to void an invoice money has arrived against", async () => {
    /**
     * A payment with nothing to allocate to is stranded. That is a refund,
     * which is a different posting and a different conversation.
     */
    const { id } = await anInvoice();
    await billing.pay(owner(), {
      customerId: tenantId, method: "check", amount: "100.00", tipAmount: "0",
      allocations: [{ invoiceId: id, amount: "100.00" }],
    });

    await expect(billing.voidInvoice(owner(), { id, reason: "Too late" }))
      .rejects.toThrow(/Refund the payment first/);
  });

  it("writes off the outstanding balance, never the total", async () => {
    /**
     * An invoice half paid and then written off would otherwise remove a
     * receivable that was already settled in cash.
     */
    const { id } = await anInvoice();
    await billing.pay(owner(), {
      customerId: tenantId, method: "check", amount: "150.00", tipAmount: "0",
      allocations: [{ invoiceId: id, amount: "150.00" }],
    });

    await billing.writeOff(owner(), { id, reason: "Customer went under" });

    const [row] = await invoiceRow(id);
    expect(row!.status).toBe("written_off");
    expect(Number(row!.balance)).toBe(0);

    // 250 written off, not 400.
    const entries = await postingsFor(id);
    // 6900 is the bad debt account. Read off ACCOUNTS rather than guessed:
    // the first version used 6100 and summed zero, which would have passed
    // just as happily against a write off that posted nothing at all.
    const writeOffAmount = entries
      .filter((e) => e.account === "6900")
      .reduce((total, e) => total + Number(e.signed), 0);
    expect(writeOffAmount).toBe(250);
  });

  it("refuses to write off an invoice with nothing outstanding", async () => {
    // A zero pair in the ledger, and a paid invoice marked as a bad debt.
    const { id, total } = await anInvoice();
    await billing.pay(owner(), {
      customerId: tenantId, method: "check", amount: total, tipAmount: "0",
      allocations: [{ invoiceId: id, amount: total }],
    });

    await expect(billing.writeOff(owner(), { id, reason: "Nope" }))
      .rejects.toThrow(/nothing outstanding/i);
  });

  it("treats both endings as final", async () => {
    /**
     * Voiding a written off invoice, or writing off a void one, posts a
     * second entry against a receivable that is already gone and takes the
     * ledger out of agreement with itself.
     */
    const { id } = await anInvoice();
    await billing.writeOff(owner(), { id, reason: "Gone" });

    await expect(billing.writeOff(owner(), { id, reason: "Again" }))
      .rejects.toThrow(/already written off/i);
    await expect(billing.voidInvoice(owner(), { id, reason: "Also" }))
      .rejects.toThrow(/already written off/i);
  });
});
