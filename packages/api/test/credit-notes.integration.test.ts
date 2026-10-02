import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as creditNotes from "../src/services/credit-notes";
import * as customers from "../src/services/customers";
import { ConflictError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { PermissionError } from "@opentradesos/core";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * CREDIT NOTES
 *
 * The bill asked for too much. Not a void, because the invoice was right to
 * exist, and not a write off, because nothing was lost to a customer who would
 * not pay. These tests are about the three numbers that have to agree after a
 * credit: what the invoice still says it is owed, what the ledger says, and
 * how much of the credit is still sitting on the customer's account.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cn:org");
const USER = fixtureId("cn:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"] as Actor["roles"], key);

let customerId = "";
let otherCustomerId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Credit Co", slug: "credit-co" });
  customerId = (await customers.create(owner(), {
    type: "residential", name: "Rosa Credit", phone: "+15125550190",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
  otherCustomerId = (await customers.create(owner(), {
    type: "residential", name: "Otto Other", phone: "+15125550191",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

/** Two lines: 300 of labour, taxable at 8.25%, and 100 of parts, not taxed. */
async function anInvoice(forCustomer = customerId) {
  return billing.create(owner(), {
    customerId: forCustomer,
    lines: [
      { name: "Capacitor replacement", quantity: "1", unitPrice: "300.00", discountAmount: "0", taxable: true, taxRate: "0.0825" },
      { name: "Service call", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false },
    ],
  });
}

const invoiceRow = async (id: string) =>
  (await raw<{ status: string; balance: string; amount_paid: string; amount_credited: string }[]>`
    select status, balance, amount_paid, amount_credited from public.invoice where id = ${id}`)[0]!;

/** Net of every posting a credit note made, per account, in cents. */
async function netFor(sourceId: string) {
  const rows = await raw<{ account: string; signed: string }[]>`
    select account_code as account,
           case when direction = 'debit' then amount else -amount end as signed
    from public.ledger_entry where organization_id = ${ORG} and source_id = ${sourceId}`;
  const net = new Map<string, number>();
  for (const r of rows) net.set(r.account, Math.round(((net.get(r.account) ?? 0) + Number(r.signed)) * 100) / 100);
  return net;
}

run("raising a credit against an invoice line", () => {
  it("gives back the line's revenue and the tax it charged, and takes it off the balance", async () => {
    const invoice = await anInvoice();
    const capacitor = invoice.lines.find((l) => l.name === "Capacitor replacement")!;

    const note = await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ invoiceLineId: capacitor.id, quantity: "1", unitPrice: "100.00" }],
    });

    expect(note.status).toBe("applied");
    expect(note.customerId).toBe(customerId);
    expect(note.subtotal).toMatch(/^100(\.0+)?$/);
    // Tax at the invoice line's rate as applied, never today's.
    expect(Number(note.taxTotal)).toBe(8.25);
    expect(Number(note.total)).toBe(108.25);
    expect(note.lines[0]!.name).toBe("Capacitor replacement");
    expect(note.applications).toHaveLength(1);
    expect(note.applications[0]!.invoiceNumber).toBe(invoice.number);

    const row = await invoiceRow(invoice.id);
    expect(Number(row.balance)).toBe(Number(invoice.total) - 108.25);
    expect(Number(row.amount_credited)).toBe(108.25);
    // A credit is never counted as money arriving.
    expect(Number(row.amount_paid)).toBe(0);
    expect(row.status).toBe("partially_paid");

    const net = await netFor(note.id);
    expect(net.get("4000")).toBe(100);     // revenue reversed
    expect(net.get("2200")).toBe(8.25);    // tax no longer owed
    expect(net.get("1200")).toBe(-108.25); // receivable reduced
    expect(net.get("2300") ?? 0).toBe(0);  // issued and fully applied: nothing held
  });

  it("will not credit a line for more than it charged, counting earlier credits", async () => {
    const invoice = await anInvoice();
    const capacitor = invoice.lines.find((l) => l.name === "Capacitor replacement")!;
    await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "price_adjustment", draft: false, apply: true,
      lines: [{ invoiceLineId: capacitor.id, quantity: "1", unitPrice: "250.00" }],
    });
    await expect(creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "price_adjustment", draft: false, apply: true,
      lines: [{ invoiceLineId: capacitor.id, quantity: "1", unitPrice: "60.00" }],
    })).rejects.toThrow(/has 50\.00 left to credit/);
  });

  it("counts drafts, so two drafts from one complaint cannot both credit the whole line", async () => {
    const invoice = await anInvoice();
    const capacitor = invoice.lines.find((l) => l.name === "Capacitor replacement")!;
    await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: true, apply: true,
      lines: [{ invoiceLineId: capacitor.id, quantity: "1", unitPrice: "300.00" }],
    });
    await expect(creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: true, apply: true,
      lines: [{ invoiceLineId: capacitor.id, quantity: "1", unitPrice: "1.00" }],
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a line that is not on the invoice", async () => {
    const invoice = await anInvoice();
    const elsewhere = await anInvoice();
    await expect(creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ invoiceLineId: elsewhere.lines[0]!.id, quantity: "1", unitPrice: "10.00" }],
    })).rejects.toBeInstanceOf(UnprocessableError);
  });

  it("refuses a void invoice, and asks for words beside goodwill", async () => {
    const invoice = await anInvoice();
    await billing.voidInvoice(owner(), { id: invoice.id, reason: "Wrong property" });
    await expect(creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ name: "Anything", quantity: "1", unitPrice: "10.00" }],
    })).rejects.toThrow(/void/);

    await expect(creditNotes.create(owner(), {
      customerId, reason: "goodwill", draft: false, apply: true,
      lines: [{ name: "Sorry about the mud", quantity: "1", unitPrice: "25.00" }],
    })).rejects.toThrow(/Goodwill needs a note/);
  });

  it("keeps what a paid invoice no longer owes on the account as credit", async () => {
    const invoice = await anInvoice();
    await billing.pay(owner(), {
      customerId, method: "check", amount: invoice.total, tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: invoice.total }],
    });
    const note = await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "work_not_done", draft: false, apply: true,
      lines: [{ invoiceLineId: invoice.lines.find((l) => l.name === "Service call")!.id, quantity: "1", unitPrice: "100.00" }],
    });
    expect(note.status).toBe("open");
    expect(Number(note.balance)).toBe(100);
    expect(note.applications).toHaveLength(0);
    expect(Number((await netFor(note.id)).get("2300"))).toBe(-100);
  });
});

run("applying a standing credit", () => {
  it("puts it against open invoices, never more than either side has", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "goodwill", note: "Took three visits to fix", draft: false, apply: true,
      lines: [{ name: "Goodwill credit", quantity: "1", unitPrice: "150.00" }],
    });
    expect(note.invoiceId).toBeNull();
    expect(note.status).toBe("open");
    expect(Number(note.taxTotal)).toBe(0);

    const first = await anInvoice();
    await expect(creditNotes.apply(owner(), {
      id: note.id, applications: [{ invoiceId: first.id, amount: "200.00" }],
    })).rejects.toThrow(/has 150\.00 left to apply/);

    const part = await creditNotes.apply(owner(), {
      id: note.id, applications: [{ invoiceId: first.id, amount: "100.00" }],
    });
    expect(part.status).toBe("partially_applied");
    expect(Number(part.balance)).toBe(50);

    const done = await creditNotes.apply(owner(), {
      id: note.id, applications: [{ invoiceId: first.id, amount: "50.00" }],
    });
    expect(done.status).toBe("applied");
    expect(done.applications).toHaveLength(2);
    expect(Number((await invoiceRow(first.id)).amount_credited)).toBe(150);
    expect(await creditNotes.unappliedFor(db(), customerId)).toBeDefined();
  });

  it("refuses somebody else's invoice", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "contract_adjustment", draft: false, apply: true,
      lines: [{ name: "End of contract", quantity: "1", unitPrice: "40.00" }],
    });
    const theirs = await anInvoice(otherCustomerId);
    await expect(creditNotes.apply(owner(), {
      id: note.id, applications: [{ invoiceId: theirs.id, amount: "40.00" }],
    })).rejects.toThrow(/not this customer's/);
  });

  it("is a no-op when retried with the same key", async () => {
    const note = await creditNotes.create(owner(), {
      customerId, reason: "price_adjustment", draft: false, apply: true,
      lines: [{ name: "Price match", quantity: "1", unitPrice: "30.00" }],
    });
    const invoice = await anInvoice();
    const key = `apply-${note.id}`;
    await creditNotes.apply(owner(key), { id: note.id, applications: [{ invoiceId: invoice.id, amount: "10.00" }] });
    const again = await creditNotes.apply(owner(key), { id: note.id, applications: [{ invoiceId: invoice.id, amount: "10.00" }] });
    expect(again.applications).toHaveLength(1);
    expect(Number(again.balance)).toBe(20);
  });
});

run("a balance a credit took down survives the payment that clears it", () => {
  it("does not come back when the rest is paid", async () => {
    /**
     * The bug this file found: paying an invoice recomputed its balance as
     * total less paid, which undid every credit and every deposit applied to
     * it. The customer paid what they owed and the invoice still said they
     * owed the credit.
     */
    const invoice = await anInvoice();
    await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ invoiceLineId: invoice.lines.find((l) => l.name === "Service call")!.id, quantity: "1", unitPrice: "100.00" }],
    });
    const rest = (Number(invoice.total) - 100).toFixed(2);
    await billing.pay(owner(), {
      customerId, method: "check", amount: rest, tipAmount: "0",
      allocations: [{ invoiceId: invoice.id, amount: rest }],
    });
    const row = await invoiceRow(invoice.id);
    expect(Number(row.balance)).toBe(0);
    expect(row.status).toBe("paid");
  });

  it("will not void an invoice with credit applied", async () => {
    const invoice = await anInvoice();
    await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ name: "Wrong rate", quantity: "1", unitPrice: "20.00" }],
    });
    await expect(billing.voidInvoice(owner(), { id: invoice.id, reason: "x" })).rejects.toThrow(/credit applied/);
  });
});

run("drafts, voids and who may", () => {
  it("issues a draft once, and a second issue answers rather than posting twice", async () => {
    const draft = await creditNotes.create(owner(), {
      customerId, reason: "duplicate_invoice", draft: true, apply: true,
      lines: [{ name: "Billed twice", quantity: "1", unitPrice: "75.00" }],
    });
    expect(draft.status).toBe("draft");
    expect((await netFor(draft.id)).size).toBe(0);

    await creditNotes.issue(owner(), { id: draft.id, apply: true });
    const again = await creditNotes.issue(owner(), { id: draft.id, apply: true });
    expect(again.status).toBe("open");
    expect((await netFor(draft.id)).get("2300")).toBe(-75);
  });

  it("voids an unused credit back to nothing, and refuses one that was used", async () => {
    const unused = await creditNotes.create(owner(), {
      customerId, reason: "price_adjustment", draft: false, apply: true,
      lines: [{ name: "Adjustment", quantity: "1", unitPrice: "60.00" }],
    });
    const voided = await creditNotes.voidNote(owner(), { id: unused.id, reason: "Raised in error" });
    expect(voided.status).toBe("void");
    for (const [, sum] of await netFor(unused.id)) expect(sum).toBe(0);

    const invoice = await anInvoice();
    const used = await creditNotes.create(owner(), {
      invoiceId: invoice.id, reason: "billing_error", draft: false, apply: true,
      lines: [{ name: "Wrong rate", quantity: "1", unitPrice: "20.00" }],
    });
    await expect(creditNotes.voidNote(owner(), { id: used.id, reason: "x" })).rejects.toThrow(/applied to invoices/);
  });

  it("deletes drafts only", async () => {
    const draft = await creditNotes.create(owner(), {
      customerId, reason: "billing_error", draft: true, apply: true,
      lines: [{ name: "Draft", quantity: "1", unitPrice: "5.00" }],
    });
    await creditNotes.deleteDraft(owner(), { id: draft.id });
    await expect(creditNotes.get(owner(), { id: draft.id })).rejects.toThrow(/not found/i);
  });

  it("numbers credit notes in their own sequence", async () => {
    const page = await creditNotes.list(owner(), { limit: 200, customerId });
    const numbers = page.data.map((n) => n.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(Math.min(...numbers)).toBe(1);
  });

  it("is refused to a technician, who may read an invoice and not take money off it", async () => {
    await expect(creditNotes.create(as(["technician"] as Actor["roles"]), {
      customerId, reason: "billing_error", draft: false, apply: true,
      lines: [{ name: "Nope", quantity: "1", unitPrice: "5.00" }],
    })).rejects.toBeInstanceOf(PermissionError);
  });
});
