import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as priceBook from "../src/services/pricebook";
import * as billing from "../src/services/billing";
import * as estimates from "../src/services/estimates";
import * as invoiceDelivery from "../src/services/invoice-delivery";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * INVOICING FROM THE OFFICE
 *
 * A draft that can be edited, issued and thrown away; lines that bill what
 * was used on the job exactly once; and a void that gives the job and its
 * lines back. Asked of the service the invoice screens call.
 */

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("office-invoicing:org");
const USER = fixtureId("office-invoicing:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let capacitor = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Invoicing Co", slug: "office-invoicing" });
  capacitor = (await priceBook.create(owner(), {
    kind: "material", code: "CAP-45", name: "Dual run capacitor", price: "43.37", cost: "11.20", taxable: false,
  })).id;
});
afterAll(async () => { if (raw) await raw.end(); });

/** A finished job with a capacitor used on it. */
async function finishedJob() {
  const customer = await customers.create(owner(), {
    type: "residential", name: "Invoice Customer", paymentTermsDays: 0,
    taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "2 Ledger Ln", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  const start = new Date(Date.now() + 86_400_000);
  const job = await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "No cooling", tags: [], customFields: {},
    visit: {
      windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 7_200_000).toISOString(),
      estimatedDurationMinutes: 60, technicianIds: [],
    },
  });
  await jobs.complete(owner(), {
    id: job.visits[0]!.id, partsUsed: [{ priceBookItemId: capacitor, quantity: "3" }],
  });
  const [line] = (await jobs.lines(owner(), { id: job.id })).data;
  return { customerId: customer.id, propertyId: property.id, jobId: job.id, jobLineId: line!.id };
}

const postingsFor = (invoiceId: string) =>
  raw<{ id: string }[]>`select id from public.ledger_entry where source_type = 'invoice' and source_id = ${invoiceId}`;

run("a draft invoice", () => {
  it("is numbered and nothing else: no posting, the job not invoiced, the job line held for it", async () => {
    const { customerId, jobId, jobLineId } = await finishedJob();
    const draft = await billing.create(owner(), {
      customerId, jobId, draft: true,
      lines: [{ name: "Dual run capacitor", quantity: "3", unitPrice: "43.37", discountAmount: "0", taxable: false, jobLineId }],
    });
    expect(draft.status).toBe("draft");
    expect(draft.issuedOn).toBeNull();
    expect(draft.total).toBe("130.1100");
    expect(await postingsFor(draft.id)).toHaveLength(0);
    expect((await jobs.get(owner(), { id: jobId })).status).toBe("completed");
    expect((await jobs.lines(owner(), { id: jobId })).data[0]!.invoiceLineId).toBe(draft.lines[0]!.id);
  });

  it("cannot be sent before it is issued", async () => {
    const { customerId } = await finishedJob();
    const draft = await billing.create(owner(), {
      customerId, draft: true,
      lines: [{ name: "Diagnostic", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });
    await expect(invoiceDelivery.send(owner(), { invoiceId: draft.id, channel: "portal_link" }))
      .rejects.toThrow(/still a draft/);
  });

  it("is edited by replacing its lines, priced by the same rules as a new invoice", async () => {
    const { customerId, jobId, jobLineId } = await finishedJob();
    const draft = await billing.create(owner(), {
      customerId, jobId, draft: true,
      lines: [{ name: "Diagnostic", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });
    const edited = await billing.updateDraft(owner(), {
      id: draft.id,
      lines: [
        { name: "Diagnostic", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false },
        // From the price book: the price is the book's, whatever is typed.
        { priceBookItemId: capacitor, name: "anything", quantity: "3", unitPrice: "1.00", discountAmount: "0", taxable: true, jobLineId },
      ],
      adjustment: { name: "Loyal customer", amount: "-10.00" },
      memo: "Thanks for calling us",
    });
    expect(edited.lines.map((l) => l.name)).toEqual(["Diagnostic", "Dual run capacitor", "Loyal customer"]);
    expect(edited.subtotal).toBe("259.1100");
    expect(edited.discountTotal).toBe("10.0000");
    expect(edited.total).toBe("249.1100");
    expect(edited.balance).toBe("249.1100");
    expect(edited.memo).toBe("Thanks for calling us");
  });

  it("is issued: posted, the job invoiced, and from then on not edited or deleted", async () => {
    const { customerId, jobId } = await finishedJob();
    const draft = await billing.create(owner(), {
      customerId, jobId, draft: true,
      lines: [{ name: "Diagnostic", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });
    const issued = await billing.issue(owner(), { id: draft.id });
    expect(issued.status).toBe("open");
    expect(issued.issuedOn).not.toBeNull();
    expect(issued.number).toBe(draft.number);
    expect(await postingsFor(draft.id)).not.toHaveLength(0);
    expect((await jobs.get(owner(), { id: jobId })).status).toBe("invoiced");

    await expect(billing.updateDraft(owner(), { id: draft.id, memo: "changed" })).rejects.toThrow(/has been issued/);
    await expect(billing.deleteDraft(owner(), { id: draft.id })).rejects.toThrow(/has been issued/);
    await expect(billing.issue(owner(), { id: draft.id })).rejects.toThrow(/has been issued/);
  });

  it("is deleted, giving its job lines back", async () => {
    const { customerId, jobId, jobLineId } = await finishedJob();
    const draft = await billing.create(owner(), {
      customerId, jobId, draft: true,
      lines: [{ name: "Dual run capacitor", quantity: "3", unitPrice: "43.37", discountAmount: "0", taxable: false, jobLineId }],
    });
    await billing.deleteDraft(owner(), { id: draft.id });
    await expect(billing.get(owner(), { id: draft.id })).rejects.toThrow(/not found/);
    expect((await jobs.lines(owner(), { id: jobId })).data[0]!.invoiceLineId).toBeNull();
  });

  it("converted from an approved estimate can at last be issued", async () => {
    const { customerId, propertyId } = await finishedJob();
    const estimate = await estimates.create(owner(), {
      customerId, propertyId, taxRate: "0",
      options: [{ name: "Replace", isRecommended: true, lines: [{
        name: "Condenser", quantity: "1", unitPrice: "5480.00", discountAmount: "0", taxable: false,
        isOptional: false, isSelected: false,
      }] }],
    });
    await estimates.approve(owner(), {
      id: estimate.id, optionId: estimate.options[0]!.id, selectedLineIds: [],
      signerName: "Pat Customer", capturedVia: "in_person",
    });
    const converted = await estimates.convert(owner(), { id: estimate.id, createJob: true, createInvoice: true });
    const draft = await billing.get(owner(), { id: converted.invoiceId! });
    expect(draft.status).toBe("draft");
    const issued = await billing.issue(owner(), { id: draft.id });
    expect(issued.status).toBe("open");
    expect(issued.total).toBe("5480.0000");
    expect(await postingsFor(draft.id)).not.toHaveLength(0);
  });
});

run("billing what was used on the job", () => {
  it("bills a job line once, and refuses it on a second invoice", async () => {
    const { customerId, jobId, jobLineId } = await finishedJob();
    await billing.create(owner(), {
      customerId, jobId,
      lines: [{ name: "Dual run capacitor", quantity: "3", unitPrice: "43.37", discountAmount: "0", taxable: false, jobLineId }],
    });
    await expect(billing.create(owner(), {
      customerId, jobId,
      lines: [{ name: "Dual run capacitor", quantity: "3", unitPrice: "43.37", discountAmount: "0", taxable: false, jobLineId }],
    })).rejects.toThrow(/already on another invoice/);
  });

  it("refuses another job's line", async () => {
    const one = await finishedJob();
    const other = await finishedJob();
    await expect(billing.create(owner(), {
      customerId: one.customerId, jobId: one.jobId,
      lines: [{ name: "Capacitor", quantity: "1", unitPrice: "43.37", discountAmount: "0", taxable: false, jobLineId: other.jobLineId }],
    })).rejects.toThrow(/Job line not found/);
  });

  it("gives the job and its lines back when the only invoice on it is voided", async () => {
    const { customerId, jobId, jobLineId } = await finishedJob();
    const invoice = await billing.create(owner(), {
      customerId, jobId,
      lines: [{ name: "Dual run capacitor", quantity: "3", unitPrice: "43.37", discountAmount: "0", taxable: false, jobLineId }],
    });
    expect((await jobs.get(owner(), { id: jobId })).status).toBe("invoiced");
    await billing.voidInvoice(owner(), { id: invoice.id, reason: "Raised against the wrong job" });
    expect((await jobs.get(owner(), { id: jobId })).status).toBe("completed");
    expect((await jobs.lines(owner(), { id: jobId })).data[0]!.invoiceLineId).toBeNull();
  });

  it("leaves the job invoiced when another invoice still bills it", async () => {
    const { customerId, jobId } = await finishedJob();
    const first = await billing.create(owner(), {
      customerId, jobId,
      lines: [{ name: "Diagnostic", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });
    await billing.create(owner(), {
      customerId, jobId,
      lines: [{ name: "Return trip", quantity: "1", unitPrice: "89.00", discountAmount: "0", taxable: false }],
    });
    await billing.voidInvoice(owner(), { id: first.id, reason: "Duplicate" });
    expect((await jobs.get(owner(), { id: jobId })).status).toBe("invoiced");
  });
});
