import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as contracts from "../src/services/contracts";
import * as billing from "../src/services/billing";
import * as obligations from "../src/services/obligations";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as priceBook from "../src/services/pricebook";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHOSE PRICE GOVERNS
 *
 * Our price book is not the price authority in commercial work. The client
 * sends a rate card, the card is the agreement, and an invoice priced off
 * our own book gets rejected. `service_contract`, `contract_site`,
 * `rate_card` and `rate_card_line` were in the schema from the first
 * migrations and nothing read or wrote any of them, so every contract job
 * invoiced at list and nobody found out until the client said no.
 *
 * The tests here are about the two decisions that make this work or not:
 *
 * 1. NOT COVERED IS A REFUSAL, NOT A FALLBACK. An item missing from the
 *    card comes back refused, and the refusal distinguishes "no card
 *    applies, use the price book" from "a card applies and this is not on
 *    it, ring the client". A single false would collapse those two, and one
 *    of them is a mistake in progress.
 *
 * 2. THE COST STAYS OURS. The price comes from their card, the cost comes
 *    from our own records, so the margin is still true on work we did not
 *    price. A system that took the card's price as both would report every
 *    contract job at zero margin.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ct:org");
const USER = fixtureId("ct:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** A facilities client on a contract, and a homeowner who is on nobody's card. */
let clientId = "";
let walkInId = "";
let warehouseId = "";
let retailId = "";
/** Two items we sell, both with a cost, so margin can be checked. */
let filterId = "";
let coilId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Contract Co", slug: "contract-co" });

  const client = await customers.create(owner(), {
    type: "commercial", name: "Northwind Facilities", phone: "+15125550201",
    paymentTermsDays: 45, taxExempt: false, tags: [], customFields: {},
  });
  clientId = client.id;

  const walkIn = await customers.create(owner(), {
    type: "residential", name: "Wanda Walkin", phone: "+15125550202",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  walkInId = walkIn.id;

  const warehouse = await properties.create(owner(), {
    address: { line1: "900 Dock Rd", city: "Austin", state: "TX", postalCode: "78741", country: "US" },
    hasDog: false, customFields: {}, customerId: client.id, customerRole: "owner",
  });
  warehouseId = warehouse.id;

  const retail = await properties.create(owner(), {
    address: { line1: "12 Mall Ct", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId: client.id, customerRole: "owner",
  });
  retailId = retail.id;

  const filter = await priceBook.create(owner(), {
    kind: "material", code: "FLT-20", name: "20x25 pleated filter",
    price: "48.00", cost: "12.00", taxable: true,
  });
  filterId = filter.id;

  const coil = await priceBook.create(owner(), {
    kind: "service", code: "COIL-CLN", name: "Coil clean",
    price: "380.00", cost: "95.00", taxable: true,
  });
  coilId = coil.id;
});

afterAll(async () => { if (raw) await raw.end(); });

/**
 * Contracts and cards are torn down between tests, customers and items are
 * not. A card left behind by one test is a card that applies in the next,
 * and the failure would read as a pricing bug rather than as dirty state.
 */
beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.rate_card_line where organization_id = ${ORG}`;
  await raw`delete from public.rate_card where organization_id = ${ORG}`;
  await raw`delete from public.contract_site where organization_id = ${ORG}`;
  await raw`delete from public.service_contract where organization_id = ${ORG}`;
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  await raw`delete from public.invoice where organization_id = ${ORG}`;
  await raw`delete from public.obligation where organization_id = ${ORG}`;
});

async function contractWithCard(lines: contracts.RateCardLineInput[], dates: {
  startsOn?: string; endsOn?: string; effectiveFrom?: string; effectiveTo?: string;
} = {}) {
  const contract = await contracts.createContract(owner(), {
    customerId: clientId, name: "Northwind MSA 2026", contractNumber: "NW-2026",
    startsOn: dates.startsOn ?? null, endsOn: dates.endsOn ?? null,
    defaultNotToExceed: "500.00",
  });
  const card = await contracts.createRateCard(owner(), {
    name: "Northwind schedule A", contractId: contract.id, authority: "contract",
    effectiveFrom: dates.effectiveFrom ?? null, effectiveTo: dates.effectiveTo ?? null,
  });
  await contracts.setRateCardLines(owner(), { rateCardId: card.id, lines });
  return { contract, card };
}

run("resolving a price", () => {
  it("returns the card's price, not the price book's", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter, contract rate", price: "31.50" },
    ]);

    const resolution = await contracts.priceFor(owner(), {
      customerId: clientId, priceBookItemId: filterId,
    });

    expect(resolution.covered).toBe(true);
    if (!resolution.covered) throw new Error("unreachable");
    expect(resolution.price).toBe("31.5000");
    expect(resolution.authority).toBe("contract");
    expect(resolution.rateCardName).toBe("Northwind schedule A");
  });

  it("tells a customer with no card apart from an item off the card", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter, contract rate", price: "31.50" },
    ]);

    /**
     * THE DISTINCTION THE WHOLE FILE TURNS ON. Both are `covered: false`
     * and they mean opposite things: one says charge our list price, the
     * other says do not charge anything until somebody rings the client.
     */
    const noCard = await contracts.priceFor(owner(), {
      customerId: walkInId, priceBookItemId: filterId,
    });
    expect(noCard.covered).toBe(false);
    if (noCard.covered) throw new Error("unreachable");
    expect(noCard.cardApplies).toBe(false);

    const offCard = await contracts.priceFor(owner(), {
      customerId: clientId, priceBookItemId: coilId,
    });
    expect(offCard.covered).toBe(false);
    if (offCard.covered) throw new Error("unreachable");
    expect(offCard.cardApplies).toBe(true);
    expect(offCard.reason).toMatch(/not on any of them/);
  });

  it("never falls back to our list price", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter", price: "31.50" },
    ]);

    const offCard = await contracts.priceFor(owner(), {
      customerId: clientId, priceBookItemId: coilId,
    });

    /**
     * The coil is 380.00 in our book. If a fallback ever creeps in, this is
     * where it shows: a covered resolution carrying the list price, which
     * would read as agreed and is not.
     *
     * Asserted as "no price came back at all" rather than "the price is not
     * 380", because a fallback that rounded, escalated or discounted on the
     * way through would slip past the second test and is the same defect.
     */
    expect(offCard.covered).toBe(false);
    expect(offCard).not.toHaveProperty("price");
  });

  it("matches on their code when we have no item mapped", async () => {
    await contractWithCard([
      { externalCode: "NW-FILTER-A", description: "Their line item", price: "29.00" },
    ]);

    const resolution = await contracts.priceFor(owner(), {
      customerId: clientId, externalCode: "NW-FILTER-A",
    });
    expect(resolution).toMatchObject({ covered: true, price: "29.0000" });
  });

  it("carries the allowed minutes an allowance schedule pays", async () => {
    const contract = await contracts.createContract(owner(), {
      customerId: clientId, name: "Manufacturer warranty", startsOn: null, endsOn: null,
    });
    const card = await contracts.createRateCard(owner(), {
      name: "Allowance schedule", contractId: contract.id, authority: "manufacturer_allowance",
    });
    await contracts.setRateCardLines(owner(), {
      rateCardId: card.id,
      lines: [{ priceBookItemId: coilId, description: "Coil, allowance", price: "210.00", allowedMinutes: 90 }],
    });

    const resolution = await contracts.priceFor(owner(), {
      customerId: clientId, priceBookItemId: coilId,
    });
    expect(resolution).toMatchObject({
      covered: true, price: "210.0000", authority: "manufacturer_allowance", allowedMinutes: 90,
    });
  });

  it("refuses a lookup that names neither an item nor a code", async () => {
    await expect(contracts.priceFor(owner(), { customerId: clientId }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

run("effective dates", () => {
  it("does not price off a card that has expired", async () => {
    await contractWithCard(
      [{ priceBookItemId: filterId, description: "Filter", price: "31.50" }],
      { effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" },
    );

    const during = await contracts.priceFor(owner(), {
      customerId: clientId, priceBookItemId: filterId, on: "2025-06-01",
    });
    expect(during).toMatchObject({ covered: true, price: "31.5000" });

    /**
     * A card that expired on the 31st is not the authority on the 1st,
     * whatever anybody remembered to untick. Read from the dates, not from
     * the flag.
     */
    const after = await contracts.priceFor(owner(), {
      customerId: clientId, priceBookItemId: filterId, on: "2026-01-01",
    });
    expect(after).toMatchObject({ covered: false, cardApplies: false });
  });

  it("does not price off a contract that has not started", async () => {
    await contractWithCard(
      [{ priceBookItemId: filterId, description: "Filter", price: "31.50" }],
      { startsOn: "2027-01-01" },
    );

    const early = await contracts.priceFor(owner(), {
      customerId: clientId, priceBookItemId: filterId, on: "2026-09-24",
    });
    expect(early).toMatchObject({ covered: false, cardApplies: false });
  });

  it("refuses a contract that ends before it starts", async () => {
    await expect(contracts.createContract(owner(), {
      customerId: clientId, name: "Backwards", startsOn: "2027-01-01", endsOn: "2026-01-01",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a card that expires before it takes effect", async () => {
    const contract = await contracts.createContract(owner(), {
      customerId: clientId, name: "Fine", startsOn: null, endsOn: null,
    });
    await expect(contracts.createRateCard(owner(), {
      name: "Backwards card", contractId: contract.id,
      effectiveFrom: "2027-01-01", effectiveTo: "2026-01-01",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a contract rate card with no contract on it", async () => {
    /**
     * Without a contract there is no customer the card applies to, so it
     * would sit in the table looking like coverage and never be found.
     */
    await expect(contracts.createRateCard(owner(), {
      name: "Orphan", authority: "contract",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses an authority this product does not know", async () => {
    const contract = await contracts.createContract(owner(), {
      customerId: clientId, name: "Fine", startsOn: null, endsOn: null,
    });
    await expect(contracts.createRateCard(owner(), {
      name: "Made up", contractId: contract.id, authority: "handshake",
    })).rejects.toBeInstanceOf(ConflictError);
  });
});

run("loading a card", () => {
  it("replaces the lines rather than adding to them", async () => {
    const { card } = await contractWithCard([
      { priceBookItemId: filterId, description: "Filter", price: "31.50" },
      { externalCode: "NW-OLD", description: "Something they dropped", price: "17.00" },
    ]);

    /** Next year's schedule arrives as one document. */
    await contracts.setRateCardLines(owner(), {
      rateCardId: card.id,
      lines: [{ priceBookItemId: filterId, description: "Filter", price: "33.00" }],
    });

    const lines = await contracts.rateCardLines(owner(), card.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ price: "33.0000" });

    /**
     * The line the client DELETED must stop being quotable. Appending would
     * leave it priced forever, which is how a contractor keeps billing a
     * code that came off the agreement two years ago.
     */
    const dropped = await contracts.priceFor(owner(), {
      customerId: clientId, externalCode: "NW-OLD",
    });
    expect(dropped).toMatchObject({ covered: false, cardApplies: true });
  });

  it("refuses a line that maps to neither their code nor our item", async () => {
    const { card } = await contractWithCard([]);
    const result = await contracts.setRateCardLines(owner(), {
      rateCardId: card.id,
      lines: [
        { priceBookItemId: filterId, description: "Fine", price: "31.50" },
        { description: "Nothing could ever match this", price: "9.00" },
      ],
    });

    expect(result.accepted).toBe(1);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({ row: 2 });
    expect(await contracts.rateCardLines(owner(), card.id)).toHaveLength(1);
  });

  it("refuses a line whose price is not an amount, and says which row", async () => {
    const { card } = await contractWithCard([]);
    const result = await contracts.setRateCardLines(owner(), {
      rateCardId: card.id,
      lines: [
        { priceBookItemId: filterId, description: "Fine", price: "31.50" },
        { externalCode: "NW-BAD", description: "Typo", price: "thirty one fifty" },
        { externalCode: "NW-NEG", description: "Negative", price: "-5.00" },
      ],
    });

    expect(result.accepted).toBe(1);
    expect(result.refused.map((r) => r.row)).toEqual([2, 3]);
  });
});

run("ceilings", () => {
  it("lets a site override the contract's default", async () => {
    const { contract } = await contractWithCard([]);
    await contracts.addSite(owner(), {
      contractId: contract.id, propertyId: warehouseId, siteNumber: "DC-1", notToExceed: "1000.00",
    });
    await contracts.addSite(owner(), {
      contractId: contract.id, propertyId: retailId, siteNumber: "RT-7", notToExceed: null,
    });

    const warehouse = await contracts.ceilingForProperty(owner(), {
      customerId: clientId, propertyId: warehouseId,
    });
    expect(warehouse).toMatchObject({ notToExceed: "1000.0000", fromSite: true, siteNumber: "DC-1" });

    /**
     * A site with no limit of its own falls to the contract default, and
     * says so. The two differ by design: a thousand at the distribution
     * centre and five hundred everywhere else, under one agreement.
     */
    const retail = await contracts.ceilingForProperty(owner(), {
      customerId: clientId, propertyId: retailId,
    });
    expect(retail).toMatchObject({ notToExceed: "500.0000", fromSite: false });
  });

  it("has no ceiling for a property that is on no contract", async () => {
    await contractWithCard([]);
    expect(await contracts.ceilingForProperty(owner(), {
      customerId: clientId, propertyId: retailId,
    })).toBeNull();
  });
});

run("invoicing under a contract", () => {
  it("prices the line off the card and keeps our cost", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter, contract rate", price: "31.50" },
    ]);

    const invoice = await billing.create(owner(), {
      customerId: clientId,
      lines: [{
        priceBookItemId: filterId, name: "20x25 pleated filter",
        quantity: "4", unitPrice: "48.00", discountAmount: "0", taxable: true,
      }],
    });

    const lines = await raw<{ unit_price: string; unit_cost: string | null }[]>`
      select unit_price, unit_cost from public.invoice_line
      where invoice_id = ${invoice.id}`;

    expect(lines).toHaveLength(1);
    /** Their price. */
    expect(Number(lines[0]!.unit_price)).toBe(31.5);
    /**
     * OUR COST, UNTOUCHED. This is the assertion that keeps margin true on
     * work we did not price. A card that set both would report every
     * contract job at zero margin and nobody would question it, because the
     * number would be internally consistent.
     */
    expect(Number(lines[0]!.unit_cost)).toBe(12);
  });

  it("ignores a unit price the caller sent, under a contract as without one", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter", price: "31.50" },
    ]);

    const invoice = await billing.create(owner(), {
      customerId: clientId,
      lines: [{
        priceBookItemId: filterId, name: "20x25 pleated filter",
        quantity: "1", unitPrice: "999.00", discountAmount: "0", taxable: true,
      }],
    });

    const [line] = await raw<{ unit_price: string }[]>`
      select unit_price from public.invoice_line where invoice_id = ${invoice.id}`;
    expect(Number(line!.unit_price)).toBe(31.5);
  });

  it("raises an obligation for an item the card does not cover", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter", price: "31.50" },
    ]);

    const invoice = await billing.create(owner(), {
      customerId: clientId,
      lines: [
        {
          priceBookItemId: filterId, name: "20x25 pleated filter",
          quantity: "1", unitPrice: "48.00", discountAmount: "0", taxable: true,
        },
        {
          priceBookItemId: coilId, name: "Coil clean",
          quantity: "1", unitPrice: "380.00", discountAmount: "0", taxable: true,
        },
      ],
    });

    /**
     * The uncovered line is still invoiced, at our list price, because
     * refusing to invoice at all would strand the work. What must not
     * happen is it going out SILENTLY: somebody has to agree a price
     * before this reaches the client.
     */
    const raised = await obligations.open(owner(), { kind: "contract.price_not_on_card" });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ entityType: "invoice", entityId: invoice.id });
    expect(raised[0]!.consequence).toContain("Coil clean");
  });

  it("raises nothing when every line is on the card", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter", price: "31.50" },
      { priceBookItemId: coilId, description: "Coil clean", price: "260.00" },
    ]);

    await billing.create(owner(), {
      customerId: clientId,
      lines: [
        { priceBookItemId: filterId, name: "Filter", quantity: "1", unitPrice: "48.00", discountAmount: "0", taxable: true },
        { priceBookItemId: coilId, name: "Coil", quantity: "1", unitPrice: "380.00", discountAmount: "0", taxable: true },
      ],
    });

    expect(await obligations.open(owner(), { kind: "contract.price_not_on_card" })).toHaveLength(0);
  });

  it("raises nothing for a customer who is on no contract at all", async () => {
    await contractWithCard([
      { priceBookItemId: filterId, description: "Filter", price: "31.50" },
    ]);

    /**
     * The walk in has no card, so our price book IS the authority and
     * there is nothing to agree. An obligation here would be a queue of
     * deadlines that fills with every residential invoice, which is how a
     * queue stops being read.
     */
    await billing.create(owner(), {
      customerId: walkInId,
      lines: [{
        priceBookItemId: coilId, name: "Coil clean",
        quantity: "1", unitPrice: "380.00", discountAmount: "0", taxable: true,
      }],
    });

    expect(await obligations.open(owner(), { kind: "contract.price_not_on_card" })).toHaveLength(0);
    const [line] = await raw<{ unit_price: string }[]>`
      select l.unit_price from public.invoice_line l
      join public.invoice i on i.id = l.invoice_id
      where i.customer_id = ${walkInId}`;
    expect(Number(line!.unit_price)).toBe(380);
  });
});

run("the overview the screen reads", () => {
  /**
   * THE LINE COUNT IS THE WHOLE POINT OF THAT SCREEN.
   *
   * It leads with "cards in force, and priced lines across them", because a
   * contract with a card and no lines is the quiet failure: it looks
   * complete, every item quoted comes back out of scope, and the person
   * quoting reads that as a fussy client.
   *
   * The count shipped as a correlated subquery drizzle rendered with bare
   * column names, so it compared `rate_card_line.rate_card_id` to
   * `rate_card_line.id` and came back zero for every card. Valid SQL, no
   * warning, and the screen's own warning fired on every contract there was.
   */
  it("counts the lines on each card, rather than zero", async () => {
    const { card } = await contractWithCard([
      { priceBookItemId: filterId, description: "Filter", price: "31.50" },
      { priceBookItemId: coilId, description: "Coil clean", price: "260.00" },
      { externalCode: "NW-X", description: "Their own code", price: "12.00" },
    ]);

    const rows = await contracts.overview(owner());
    expect(rows).toHaveLength(1);
    const found = rows[0]!.cards.find((c) => c.id === card.id);
    expect(found?.lines).toBe(3);
    expect(rows[0]!.pricedLines).toBe(3);
  });

  it("reports an empty card as empty, which is the state worth warning about", async () => {
    await contractWithCard([]);
    const rows = await contracts.overview(owner());
    expect(rows[0]!.cards).toHaveLength(1);
    expect(rows[0]!.pricedLines).toBe(0);
  });

  it("reads in force from the dates rather than the flag", async () => {
    await contractWithCard(
      [{ priceBookItemId: filterId, description: "Filter", price: "31.50" }],
      { startsOn: "2020-01-01", endsOn: "2020-12-31" },
    );
    const rows = await contracts.overview(owner());
    expect(rows[0]).toMatchObject({ inForce: false, ended: true });
  });

  it("carries the site ceilings, falling back to the contract default", async () => {
    const { contract } = await contractWithCard([]);
    await contracts.addSite(owner(), {
      contractId: contract.id, propertyId: warehouseId, siteNumber: "DC-1", notToExceed: "1000.00",
    });
    await contracts.addSite(owner(), {
      contractId: contract.id, propertyId: retailId, siteNumber: "RT-7", notToExceed: null,
    });

    const rows = await contracts.overview(owner());
    const sites = rows[0]!.sites;
    expect(sites).toHaveLength(2);
    expect(sites.find((s) => s.siteNumber === "DC-1")).toMatchObject({
      notToExceed: "1000.0000", fromSite: true,
    });
    expect(sites.find((s) => s.siteNumber === "RT-7")).toMatchObject({
      notToExceed: "500.0000", fromSite: false,
    });
  });
});
