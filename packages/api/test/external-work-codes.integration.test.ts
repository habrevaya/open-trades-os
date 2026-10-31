import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as externalWork from "../src/services/external-work";
import * as codes from "../src/services/external-work-codes";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as priceBook from "../src/services/pricebook";
import * as contracts from "../src/services/contracts";
import * as jobBilling from "../src/services/job-billing";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A CLIENT'S OWN CODES BECOME JOB LINES AND PRICES (M31)
 *
 * A facilities client writes "PLB-07 Leaking tap" on its orders. The office maps
 * each of that client's codes to a kind of work and a price book item; accepting
 * an order then PROPOSES the job from the codes, the office confirms it, and the
 * job is made with its lines carrying the client's code so the client's card can
 * price them by it. A code nobody mapped is named in words and lands in the job's
 * notes. Nothing is applied without the confirmation, and accepting by hand is
 * unchanged.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cwc:org");
const USER = fixtureId("cwc:user");
const OTHER_ORG = fixtureId("cwc:other-org");
const OTHER_USER = fixtureId("cwc:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const other = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let client = "", store = "", otherClient = "";
let plumbing = "", electrical = "";
let washer = "", callOut = "", oldItem = "";
let seq = 0;

const person = (name: string) => customers.create(owner(), {
  type: "commercial", name, phone: `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`,
  paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
});

async function order(over: Partial<externalWork.ReceiveInput> = {}) {
  seq += 1;
  return externalWork.receive(owner(), {
    sourceSystem: "servicechannel",
    externalId: `SC-${seq}-${Date.now()}`,
    externalNumber: `77${seq}`,
    externalStatus: "Open",
    customerId: client,
    codes: [
      { code: "plb-07 ", quantity: "2", description: "Leaking tap" },
      { code: "PLB-CALL" },
      { code: "HVAC-3", description: "No heat" },
    ],
    ...over,
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Client Codes Co", slug: "client-codes-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Client Codes Rival", slug: "client-codes-rival" });

  client = (await person("Harbor Retail")).id;
  otherClient = (await person("Lakeside Offices")).id;
  store = (await properties.create(owner(), {
    address: { line1: "Store 412", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: client, customerRole: "owner",
  })).id;

  const [p] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code) values (${ORG}, 'Plumbing', 'plumb') returning id`;
  plumbing = p!.id;
  const [e] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code) values (${ORG}, 'Electrical', 'elec') returning id`;
  electrical = e!.id;

  washer = (await priceBook.create(owner(), { kind: "material", code: "WASH", name: "Tap washer", price: "12.00", cost: "1.50", taxable: true })).id;
  callOut = (await priceBook.create(owner(), { kind: "service", code: "CALL", name: "Service call", price: "89.00", cost: "0", taxable: false })).id;
  oldItem = (await priceBook.create(owner(), { kind: "material", code: "OLD", name: "Old valve", price: "40.00", cost: "10.00", taxable: true })).id;

  /** Harbor's card lists their own call code, not our item: priced by their code. */
  const contract = await contracts.createContract(owner(), { customerId: client, name: "Harbor MSA", startsOn: "2020-01-01" });
  const card = await contracts.createRateCard(owner(), { name: "Harbor schedule", contractId: contract.id });
  await contracts.setRateCardLines(owner(), {
    rateCardId: card.id,
    lines: [{ externalCode: "PLB-CALL", description: "Plumbing call out", price: "65.00" }],
  });
});

afterAll(async () => { if (raw) await raw.end(); });

run("a client's list of codes", () => {
  it("is replaced as a whole, read back with names, and audited", async () => {
    const saved = await codes.setCodes(owner(), {
      customerId: client,
      codes: [
        { code: " PLB-07", description: "Leaking tap", jobTypeId: plumbing, priceBookItemId: washer, quantity: "1.5" },
        { code: "PLB-CALL", jobTypeId: plumbing, priceBookItemId: callOut },
        { code: "ELE-12", jobTypeId: electrical },
      ],
    });
    expect(saved.clientName).toBe("Harbor Retail");
    expect(saved.data.map((r) => r.code)).toEqual(["ELE-12", "PLB-07", "PLB-CALL"]);
    const tap = saved.data.find((r) => r.code === "PLB-07")!;
    expect(tap).toMatchObject({ jobTypeName: "Plumbing", itemName: "Tap washer", itemSold: true, quantity: "1.5" });

    const [audit] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'client_work_codes.set' and entity_id = ${client}`;
    expect(audit!.n).toBeGreaterThan(0);

    expect((await codes.listCodes(owner(), { customerId: client })).data).toHaveLength(3);
  });

  it("refuses a code twice, in words, and keeps the list as it was", async () => {
    await expect(codes.setCodes(owner(), {
      customerId: client,
      codes: [{ code: "PLB-07", jobTypeId: plumbing }, { code: "plb-07", jobTypeId: electrical }],
    })).rejects.toThrow("The code plb-07 is in the list twice. Keep one row for it.");
    expect((await codes.listCodes(owner(), { customerId: client })).data).toHaveLength(3);
  });

  it("refuses a row mapped to nothing and an item that is not this company's", async () => {
    await expect(codes.setCodes(owner(), { customerId: client, codes: [{ code: "X" }] }))
      .rejects.toThrow(/mapped to nothing/);
    const [theirs] = await raw<{ id: string }[]>`
      insert into public.price_book_item (organization_id, kind, code) values (${OTHER_ORG}, 'material', 'THEIRS') returning id`;
    await expect(codes.setCodes(owner(), { customerId: client, codes: [{ code: "X", priceBookItemId: theirs!.id }] }))
      .rejects.toThrow(/not in this company's price book/);
  });

  it("is written with contract:write only, and another company cannot see the client", async () => {
    await expect(codes.setCodes(granted("contract:read"), { customerId: client, codes: [] })).rejects.toThrow();
    await expect(codes.listCodes(other(), { customerId: client })).rejects.toBeInstanceOf(NotFoundError);
  });
});

run("an order's codes propose the job", () => {
  it("keeps the client and the codes as the sync sent them", async () => {
    const o = await order();
    expect(o.customerId).toBe(client);
    expect(o.clientName).toBe("Harbor Retail");
    expect(o.clientCodes).toEqual([
      { code: "plb-07", quantity: "2", description: "Leaking tap" },
      { code: "PLB-CALL", quantity: null, description: null },
      { code: "HVAC-3", quantity: null, description: "No heat" },
    ]);
    expect(o.state).toBe("offered");
  });

  it("proposes the job type, a line per mapped item priced by the card, and names the unmapped code", async () => {
    const o = await order();
    const shown = await codes.proposal(owner(), { id: o.id });
    expect(shown.refusal).toBeNull();
    expect(shown.jobTypeId).toBe(plumbing);
    expect(shown.lines).toEqual([
      expect.objectContaining({ code: "plb-07", name: "Tap washer", quantity: "3", ourPrice: "12.0000", outOfScope: true }),
      expect.objectContaining({ code: "PLB-CALL", name: "Service call", quantity: "1", ourPrice: "89.0000", unitPrice: "65.0000", pricedBy: "Client contract" }),
    ]);
    expect(shown.unmapped).toEqual([
      "HVAC-3 (No heat) is not on Harbor Retail's list of codes. Nothing is added for it; add its work by hand, or map the code first.",
    ]);
    expect(shown.places.map((p) => p.propertyId)).toEqual([store]);
  });

  it("refuses to propose for an order with no client, and says why", async () => {
    const o = await order({ customerId: null });
    const shown = await codes.proposal(owner(), { id: o.id });
    expect(shown.refusal).toBe("Say which client this order is for first. Their codes mean nothing until then.");
    expect(shown.lines).toEqual([]);

    await codes.setClient(owner(), { id: o.id, customerId: client });
    expect((await codes.proposal(owner(), { id: o.id })).refusal).toBeNull();
  });
});

run("the office confirms and the job is made", () => {
  it("makes the job with the confirmed type and lines, notes the unmapped code, and accepts the order", async () => {
    const o = await order();
    const shown = await codes.proposal(owner(), { id: o.id });
    const result = await codes.acceptAsProposed(owner("cwc-accept-1"), {
      id: o.id, key: shown.key, propertyId: store, jobTypeId: shown.jobTypeId,
    });

    expect(result.order.state).toBe("accepted");
    expect(result.order.jobId).toBe(result.jobId);
    expect(result.order.pendingPush).toBe(true);

    const [job] = await raw<{ customer_id: string; property_id: string; job_type_id: string; summary: string; description: string }[]>`
      select customer_id, property_id, job_type_id, summary, description from public.job where id = ${result.jobId}`;
    expect(job).toMatchObject({ customer_id: client, property_id: store, job_type_id: plumbing });
    expect(job!.summary).toBe(`ServiceChannel order ${o.externalNumber}`);
    expect(job!.description).toContain("Not mapped: HVAC-3 (No heat) is not on Harbor Retail's list of codes.");

    const lines = await raw<{ name: string; quantity: string; unit_price: string; client_code: string; source: string }[]>`
      select name, quantity, unit_price, client_code, source from public.job_line where job_id = ${result.jobId} order by name`;
    expect(lines).toEqual([
      { name: "Service call", quantity: "1.0000", unit_price: "89.0000", client_code: "PLB-CALL", source: "office" },
      { name: "Tap washer", quantity: "3.0000", unit_price: "12.0000", client_code: "plb-07", source: "office" },
    ]);

    /** Billing prices the call out by the client's code on their card, as the proposal said. */
    const plan = await jobBilling.preview(owner(), { jobId: result.jobId });
    expect(plan.lines.find((l) => l.name === "Service call")).toMatchObject({ basis: "card_line", unitPrice: "65.0000" });

    /** A retry with the same key answers with the first job and makes no second one. */
    const again = await codes.acceptAsProposed(owner("cwc-accept-1"), {
      id: o.id, key: shown.key, propertyId: store, jobTypeId: shown.jobTypeId,
    });
    expect(again.jobId).toBe(result.jobId);
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.job where organization_id = ${ORG} and summary = ${job!.summary}`;
    expect(count!.n).toBe(1);

    /** A second press without the key is refused: the order has its job. */
    await expect(codes.acceptAsProposed(owner(), { id: o.id, key: shown.key, propertyId: store, jobTypeId: null }))
      .rejects.toThrow("This order already has a job.");
    /** And the client cannot be changed under it. */
    await expect(codes.setClient(owner(), { id: o.id, customerId: otherClient })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a proposal the list changed under, and makes nothing", async () => {
    const o = await order();
    const shown = await codes.proposal(owner(), { id: o.id });
    const before = await codes.listCodes(owner(), { customerId: client });
    await codes.setCodes(owner(), {
      customerId: client,
      codes: [...before.data.map((r) => ({ code: r.code, jobTypeId: r.jobTypeId, priceBookItemId: r.priceBookItemId, quantity: r.quantity })),
        { code: "HVAC-3", priceBookItemId: oldItem }],
    });
    await expect(codes.acceptAsProposed(owner(), { id: o.id, key: shown.key, propertyId: store, jobTypeId: plumbing }))
      .rejects.toThrow(/changed since this was shown/);
    const [row] = await raw<{ state: string; job_id: string | null }[]>`select state, job_id from public.external_work_order where id = ${o.id}`;
    expect(row).toEqual({ state: "offered", job_id: null });

    /** Looked at again, the newly mapped code is a line. */
    const fresh = await codes.proposal(owner(), { id: o.id });
    expect(fresh.lines.map((l) => l.name)).toContain("Old valve");
    expect(fresh.unmapped).toEqual([]);
    await codes.setCodes(owner(), { customerId: client, codes: before.data.map((r) => ({ code: r.code, jobTypeId: r.jobTypeId, priceBookItemId: r.priceBookItemId, quantity: r.quantity })) });
  });

  it("refuses an address that is not the client's, and somebody who may not make jobs", async () => {
    const o = await order();
    const shown = await codes.proposal(owner(), { id: o.id });
    const elsewhere = (await properties.create(owner(), {
      address: { line1: "9 Other Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: otherClient, customerRole: "owner",
    })).id;
    await expect(codes.acceptAsProposed(owner(), { id: o.id, key: shown.key, propertyId: elsewhere, jobTypeId: null }))
      .rejects.toThrow("Choose one of Harbor Retail's addresses for the job.");
    await expect(codes.acceptAsProposed(granted("contract:write", "contract:read"), {
      id: o.id, key: shown.key, propertyId: store, jobTypeId: null,
    })).rejects.toThrow();
    const [row] = await raw<{ state: string }[]>`select state from public.external_work_order where id = ${o.id}`;
    expect(row!.state).toBe("offered");
  });

  it("leaves accepting by hand as it was", async () => {
    const o = await order();
    const moved = await externalWork.move(owner(), { id: o.id, to: "accepted" });
    expect(moved.state).toBe("accepted");
    expect(moved.jobId).toBeNull();
    const [lines] = await raw<{ n: number }[]>`select count(*)::int as n from public.job_line where client_code is not null and job_id is null`;
    expect(lines!.n).toBe(0);
  });

  it("proposes no job type when the codes disagree", async () => {
    const o = await order({ codes: [{ code: "PLB-07" }, { code: "ELE-12" }] });
    const shown = await codes.proposal(owner(), { id: o.id });
    expect(shown.jobTypeId).toBeNull();
    expect(shown.jobTypeNote).toBe("The codes point to more than one kind of work: Plumbing (PLB-07), Electrical (ELE-12). Choose which this job is.");
  });
});
