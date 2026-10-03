import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as projects from "../src/services/projects";
import * as changeOrders from "../src/services/project-change-orders";
import * as applications from "../src/services/project-applications";
import * as liens from "../src/services/project-liens";
import * as scheduling from "../src/services/project-schedule";
import { ConflictError, InvalidGrantError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M12. THE DOCUMENTS A PROJECT RUNS ON, AGAINST A REAL DATABASE.
 *
 * A CHANGE ORDER CHANGES THE CONTRACT ONLY WHEN IT IS SIGNED, and then in the
 * same transaction as the signature, whichever door the yes came through.
 *
 * AN APPLICATION FOR PAYMENT ASKS FOR WHAT THE ARITHMETIC SAYS, and the
 * invoice it becomes adds up to that to the cent, once, however many times
 * the button is pressed.
 *
 * THE SCHEDULE MOVES AS A CHAIN, and the people on it are the dispatch
 * board's booking rather than a second list.
 *
 * NOTICES AND WAIVERS ARE RECORDS, checked against the payments they name and
 * against nothing else.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m12docs:org");
const USER = fixtureId("m12docs:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<Actor> = {}, key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, ...extra }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], {}, key);

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fitout Docs Co", slug: "fitout-docs-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, email)
    values (${ORG}, 'commercial', 'Hillcrest Partners', 'owner@hillcrest.test') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '14 Hillcrest', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
});

/** A 100,000 project in two phases that make up the whole contract. */
async function fitout(input: { budget?: string | null; retainage?: string | null } = {}) {
  const project = await projects.create(owner(), {
    customerId, propertyId, name: "Hillcrest fit out", contractValue: "100000",
    budgetCost: input.budget === undefined ? "70000" : input.budget,
    retainageRate: input.retainage === undefined ? "0.1" : input.retainage,
  });
  const rough = await projects.addPhase(owner(), {
    projectId: project.id, name: "Rough in", billingValue: "60000", budgetCost: "40000",
    startsOn: "2026-11-02", endsOn: "2026-11-13",
  });
  const fixtures = await projects.addPhase(owner(), {
    projectId: project.id, name: "Fixtures", billingValue: "40000", budgetCost: "30000",
    dependsOnPhaseId: rough.id, startsOn: "2026-11-14", endsOn: "2026-11-18",
  });
  return { project, rough, fixtures };
}

async function priceBookItem(code: string, name: string, price: string, cost: string | null) {
  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code)
    values (${ORG}, 'service', ${code}) returning id`;
  await raw`insert into public.price_book_item_version
    (organization_id, item_id, version, name, price, cost, effective_from)
    values (${ORG}, ${item!.id}, 1, ${name}, ${price}, ${cost}, now() - interval '1 day')`;
  return item!.id;
}

const tokenOf = (url: string | null) => url!.split("/").pop()!;
const projectRow = async (id: string) =>
  (await raw<{ contract_value: string; budget_cost: string | null }[]>`
    select contract_value, budget_cost from public.project where id = ${id}`)[0]!;

run("a change order", () => {
  it("is priced from the price book, sent on its own link, signed by the customer, and only then moves the contract", async () => {
    const { project, rough } = await fitout();
    const itemId = await priceBookItem("CIRCUIT-20A", "Dedicated 20A circuit", "450", "180");

    const requested = await changeOrders.request(owner(), {
      projectId: project.id, title: "Two more circuits in the kitchen",
      requestedBy: "Owner", reason: "New appliances", phaseId: rough.id, scheduleDays: 2,
    });
    expect(requested.number).toBe(1);
    expect(requested.status).toBe("requested");

    await changeOrders.addLine(owner(), { changeOrderId: requested.id, priceBookItemId: itemId, quantity: "2" });
    const priced = await changeOrders.addLine(owner(), {
      changeOrderId: requested.id, name: "Patch and paint", quantity: "1", unitPrice: "125.5", unitCost: "60",
    });
    expect(priced.status).toBe("priced");
    expect(priced.amount).toBe("1025.5000");
    expect(priced.cost).toBe("420.0000");
    expect(priced.lines[0]).toMatchObject({ name: "Dedicated 20A circuit", unitPrice: "450.0000", priceSource: "price_book" });

    /** Nothing has moved: a priced change order is a quote, not an agreement. */
    expect((await projectRow(project.id)).contract_value).toBe("100000.0000");

    const sent = await changeOrders.send(owner(), { id: requested.id, channel: "email" });
    expect(sent.url).toContain("/co/");
    /**
     * No mail provider is connected in this fixture, and the send says so
     * rather than pretending: the link is still issued, to hand on another way.
     */
    expect(sent.emailed).toBe(false);
    expect(sent.reason).toMatch(/email provider/i);
    const token = tokenOf(sent.url);

    const seen = await changeOrders.viewForCustomer(db(), { token });
    expect(seen.amount).toBe("1025.5000");
    expect(seen.contractValue).toBe("100000.0000");
    expect(seen.contractValueAfter).toBe("101025.5000");
    expect(JSON.stringify(seen)).not.toContain("420");

    /** Sent is frozen: the signature covers the page as sent. */
    await expect(changeOrders.addLine(owner(), {
      changeOrderId: requested.id, name: "Extra", quantity: "1", unitPrice: "10",
    })).rejects.toThrow(/customer has a link/);

    const signed = await changeOrders.approveForCustomer(db(), {
      token, signerName: "Pat Owner", acceptedTerms: true,
    }, { ip: "203.0.113.9", userAgent: "test" });
    expect(signed.status).toBe("approved");
    expect(signed.signerName).toBe("Pat Owner");

    const after = await projectRow(project.id);
    expect(after.contract_value).toBe("101025.5000");
    expect(after.budget_cost).toBe("70420.0000");
    const [phase] = await raw<{ billing_value: string; budget_cost: string }[]>`
      select billing_value, budget_cost from public.project_phase where id = ${rough.id}`;
    expect(phase).toEqual({ billing_value: "61025.5000", budget_cost: "40420.0000" });

    const [signature] = await raw<{ signer_name: string; ip_address: string; document_hash: string }[]>`
      select signer_name, ip_address, document_hash from public.document_signature
      where subject = 'change_order' and subject_id = ${requested.id}`;
    expect(signature).toMatchObject({ signer_name: "Pat Owner", ip_address: "203.0.113.9" });
    expect(signature!.document_hash).toMatch(/^[0-9a-f]{64}$/);

    const [log] = await changeOrders.list(owner(), { projectId: project.id });
    expect(log).toMatchObject({
      status: "approved", decidedVia: "portal",
      contractValueBefore: "100000.0000", contractValueAfter: "101025.5000",
    });

    /** The link has done its job. */
    await expect(changeOrders.approveForCustomer(db(), { token, signerName: "Pat", acceptedTerms: true }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("is priced at the customer's rate card where one covers the item, and refused where one applies and does not", async () => {
    const { project } = await fitout();
    const covered = await priceBookItem("OUTLET", "Duplex outlet", "95", "20");
    const uncovered = await priceBookItem("FAN", "Ceiling fan", "300", "120");
    const [contract] = await raw<{ id: string }[]>`
      insert into public.service_contract (organization_id, customer_id, name)
      values (${ORG}, ${customerId}, 'Hillcrest master agreement') returning id`;
    const [card] = await raw<{ id: string }[]>`
      insert into public.rate_card (organization_id, name, contract_id)
      values (${ORG}, 'Hillcrest rates', ${contract!.id}) returning id`;
    await raw`insert into public.rate_card_line (organization_id, rate_card_id, price_book_item_id, description, price)
              values (${ORG}, ${card!.id}, ${covered}, 'Outlet', '80')`;

    const order = await changeOrders.request(owner(), { projectId: project.id, title: "Outlets" });
    const priced = await changeOrders.addLine(owner(), { changeOrderId: order.id, priceBookItemId: covered, quantity: "3" });
    expect(priced.lines[0]).toMatchObject({ unitPrice: "80.0000", priceSource: "rate_card", unitCost: "20.0000" });
    expect(priced.amount).toBe("240.0000");

    await expect(changeOrders.addLine(owner(), { changeOrderId: order.id, priceBookItemId: uncovered, quantity: "1" }))
      .rejects.toThrow(/not on|card/i);
  });

  it("refuses a credit that names no phase, and one that would take the contract below what was billed", async () => {
    const { project, rough } = await fitout();
    const credit = await changeOrders.request(owner(), { projectId: project.id, title: "Drop the soffit lights" });
    await changeOrders.addLine(owner(), { changeOrderId: credit.id, name: "Soffit lights", quantity: "-1", unitPrice: "800" });
    await expect(changeOrders.send(owner(), { id: credit.id })).rejects.toThrow(/which phase it comes out of/);

    await changeOrders.update(owner(), { id: credit.id, phaseId: rough.id });
    await raw`update public.project_phase set status = 'in_progress' where id = ${rough.id}`;
    const draw = await projects.planDraw(owner(), { projectId: project.id, phaseId: rough.id, label: "Rough in", amount: "59500" });
    await projects.raiseDraw(owner(), { id: draw.id });
    await expect(changeOrders.decide(owner(), { id: credit.id, decision: "approved", signerName: "Pat" }))
      .rejects.toThrow(/already been billed against Rough in/);
    expect((await projectRow(project.id)).contract_value).toBe("100000.0000");
  });

  it("takes a yes recorded by the office under estimate:approve, and keeps a no with its reason", async () => {
    const { project } = await fitout();
    const yes = await changeOrders.request(owner(), { projectId: project.id, title: "Bigger panel" });
    await changeOrders.addLine(owner(), { changeOrderId: yes.id, name: "200A panel upgrade", quantity: "1", unitPrice: "2400" });

    await expect(changeOrders.decide(as(["dispatcher"]), { id: yes.id, decision: "approved", signerName: "Pat" }))
      .rejects.toBeInstanceOf(PermissionError);
    const approved = await changeOrders.decide(owner(), { id: yes.id, decision: "approved", signerName: "Pat Owner" });
    expect(approved).toMatchObject({ status: "approved", decidedVia: "office", contractValueAfter: "102400.0000" });
    /** The same answer again is a retry; the opposite is a contradiction. */
    await changeOrders.decide(owner(), { id: yes.id, decision: "approved", signerName: "Pat Owner" });
    expect((await projectRow(project.id)).contract_value).toBe("102400.0000");
    await expect(changeOrders.decide(owner(), { id: yes.id, decision: "declined" })).rejects.toThrow(/already approved/);

    const no = await changeOrders.request(owner(), { projectId: project.id, title: "Heated floor" });
    await changeOrders.addLine(owner(), { changeOrderId: no.id, name: "Heated floor", quantity: "1", unitPrice: "3100" });
    const sent = await changeOrders.send(owner(), { id: no.id });
    await changeOrders.declineForCustomer(db(), { token: tokenOf(sent.url), reason: "Over budget" });
    const declined = await changeOrders.get(owner(), { id: no.id });
    expect(declined).toMatchObject({ status: "declined", declineReason: "Over budget", decidedVia: "portal" });
    expect((await projectRow(project.id)).contract_value).toBe("102400.0000");
  });

  it("is logged once under one key, and a resend under the same key emails nobody twice", async () => {
    const { project } = await fitout();
    const first = await changeOrders.request(owner("co-1"), { projectId: project.id, title: "Doorbell" });
    const again = await changeOrders.request(owner("co-1"), { projectId: project.id, title: "Doorbell" });
    expect(again.id).toBe(first.id);

    await changeOrders.addLine(owner("line-1"), { changeOrderId: first.id, name: "Doorbell", quantity: "1", unitPrice: "90" });
    await changeOrders.addLine(owner("line-1"), { changeOrderId: first.id, name: "Doorbell", quantity: "1", unitPrice: "90" });
    expect((await changeOrders.get(owner(), { id: first.id })).lines).toHaveLength(1);

    const sent = await changeOrders.send(owner("send-1"), { id: first.id });
    const replay = await changeOrders.send(owner("send-1"), { id: first.id });
    expect(sent.url).not.toBeNull();
    expect(replay.url).toBeNull();
    /** The first link still works: the replay did not kill it. */
    await expect(changeOrders.viewForCustomer(db(), { token: tokenOf(sent.url) })).resolves.toMatchObject({ number: 1 });
  });

  it("hides the cost from somebody who may read the job and not its cost", async () => {
    const { project } = await fitout();
    const order = await changeOrders.request(owner(), { projectId: project.id, title: "Cost" });
    await changeOrders.addLine(owner(), { changeOrderId: order.id, name: "X", quantity: "1", unitPrice: "100", unitCost: "40" });
    const seen = await changeOrders.get(as(["dispatcher"]), { id: order.id });
    expect(seen.cost).toBeNull();
    expect(seen.lines[0]!.unitCost).toBeNull();
  });
});

run("the schedule", () => {
  it("lights up the chain that decides the finish and moves followers with a dragged phase", async () => {
    const { project, rough, fixtures } = await fitout();
    const paint = await projects.addPhase(owner(), {
      projectId: project.id, name: "Paint", dependsOnPhaseId: rough.id,
      startsOn: "2026-11-14", endsOn: "2026-11-15",
    });

    const before = await scheduling.schedule(owner(), { projectId: project.id });
    expect(before.finish).toBe("2026-11-18");
    expect(before.criticalPath).toEqual([rough.id, fixtures.id]);
    expect(before.phases.find((p) => p.id === paint.id)).toMatchObject({ critical: false, floatDays: 3 });

    const moved = await scheduling.move(owner(), { id: rough.id, startsOn: "2026-11-04" });
    expect(moved.shiftDays).toBe(2);
    const after = await scheduling.schedule(owner(), { projectId: project.id });
    expect(after.phases.find((p) => p.id === fixtures.id)).toMatchObject({ startsOn: "2026-11-16", endsOn: "2026-11-20" });
    expect(after.phases.find((p) => p.id === paint.id)).toMatchObject({ startsOn: "2026-11-16", endsOn: "2026-11-17" });

    /** A retry of the same drag moves nothing further. */
    expect((await scheduling.move(owner(), { id: rough.id, startsOn: "2026-11-04" })).moves).toEqual([]);

    await expect(scheduling.move(owner(), { id: fixtures.id, startsOn: "2026-11-10" }))
      .rejects.toThrow(/earliest it can start is 2026-11-16/);
    await expect(scheduling.move(as(["accountant"]), { id: rough.id, startsOn: "2026-11-05" }))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("shows who is booked on a phase from the visits on its jobs", async () => {
    const { project, rough } = await fitout();
    await projects.materialise(owner(), { id: project.id });
    const [link] = await raw<{ job_id: string }[]>`
      select job_id from public.project_job where project_phase_id = ${rough.id}`;
    const [membership] = await raw<{ id: string }[]>`
      select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
    const [tech] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
      values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
    const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name)
      values (${ORG}, 'Framing crew') returning id`;
    const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status)
      values (${ORG}, ${link!.job_id}, 'scheduled') returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${tech!.id})`;
    await raw`insert into public.visit (organization_id, job_id, status, crew_id, sequence)
      values (${ORG}, ${link!.job_id}, 'scheduled', ${crew!.id}, 2)`;
    await raw`insert into public.visit (organization_id, job_id, status, sequence)
      values (${ORG}, ${link!.job_id}, 'unassigned', 3)`;

    const schedule = await scheduling.schedule(owner(), { projectId: project.id });
    expect(schedule.phases.find((p) => p.id === rough.id)!.booked).toEqual({
      technicians: [{ id: tech!.id, name: "Ray Nunez", visits: 1 }],
      crews: [{ id: crew!.id, name: "Framing crew", visits: 1 }],
      unassignedVisits: 1,
    });
  });
});

run("an application for payment", () => {
  it("asks for what the work and retainage come to, and raises an invoice for exactly that, once", async () => {
    const { project, rough, fixtures } = await fitout();
    const first = await applications.create(owner("app-1"), { projectId: project.id, periodTo: "2026-11-30" });
    expect(first.number).toBe(1);
    expect(first.retainageRate).toBe("0.100000");
    expect(first.lines.map((l) => [l.description, l.scheduledValue])).toEqual([
      ["Rough in", "60000.0000"], ["Fixtures", "40000.0000"],
    ]);
    expect((await applications.create(owner("app-1"), { projectId: project.id, periodTo: "2026-11-30" })).id).toBe(first.id);

    const roughLine = first.lines[0]!.id;
    const fixturesLine = first.lines[1]!.id;
    const filled = await applications.updateDraft(owner(), {
      id: first.id, storedRetainageRate: "0.05",
      lines: [{ id: roughLine, percentComplete: "33.3333".slice(0, 5) }, { id: fixturesLine, storedNow: "5000" }],
    });
    /** 33.33% of 60,000 is 19,998. */
    expect(filled.lines[0]!.workThisPeriod).toBe("19998.0000");
    await applications.updateDraft(owner(), { id: first.id, lines: [{ id: roughLine, workThisPeriod: "20000" }] });
    const ready = await applications.get(owner(), { id: first.id });
    expect(ready.totals).toMatchObject({
      totalCompletedAndStored: "25000.0000", retainageOnWork: "2000.0000", retainageOnStored: "250.0000",
      totalEarnedLessRetainage: "22750.0000", currentPaymentDue: "22750.0000",
    });

    const raised = await applications.raise(owner(), { id: first.id });
    expect(raised).toMatchObject({ amount: "22750.0000", created: true });
    const [invoice] = await raw<{ total: string; customer_id: string }[]>`
      select total, customer_id from public.invoice where id = ${raised.invoiceId}`;
    expect(invoice).toEqual({ total: "22750.0000", customer_id: customerId });
    const again = await applications.raise(owner(), { id: first.id });
    expect(again).toEqual({ applicationId: first.id, invoiceId: raised.invoiceId, amount: "22750.0000", created: false });
    const [{ n }] = await raw<{ n: number }[]>`select count(*)::int as n from public.invoice where organization_id = ${ORG}`;
    expect(n).toBe(1);

    await expect(applications.updateDraft(owner(), { id: first.id, notes: "late" })).rejects.toThrow(/has been invoiced/);

    /** An agreed change order with no phase is a line of its own on the next one. */
    const change = await changeOrders.request(owner(), { projectId: project.id, title: "Feature wall" });
    await changeOrders.addLine(owner(), { changeOrderId: change.id, name: "Feature wall", quantity: "1", unitPrice: "4000" });
    await changeOrders.decide(owner(), { id: change.id, decision: "approved", signerName: "Pat" });

    const second = await applications.create(owner(), { projectId: project.id, periodTo: "2026-12-31" });
    expect(second.periodFrom).toBe("2026-12-01");
    expect(second.lines.map((l) => l.description)).toEqual(["Rough in", "Fixtures", "Change order 1: Feature wall"]);
    expect(second.lines[0]).toMatchObject({ previousWork: "20000.0000" });
    expect(second.lines[1]).toMatchObject({ previousStored: "5000.0000", storedNow: "5000.0000" });
    const [, fx, co] = second.lines;
    const worked = await applications.updateDraft(owner(), {
      id: second.id,
      lines: [
        { id: second.lines[0]!.id, workThisPeriod: "10000" },
        { id: fx!.id, workThisPeriod: "8000", storedNow: "2000" },
        { id: co!.id, workThisPeriod: "4000" },
      ],
    });
    /**
     * Work to date 42,000, stored 2,000: retainage 4,200 + 100 = 4,300.
     * Earned 44,000 less 4,300 is 39,700, less 22,750 certified: 16,950.
     */
    expect(worked.totals).toMatchObject({
      originalContractSum: "100000.0000", netChangeOrders: "4000.0000", contractSumToDate: "104000.0000",
      totalRetainage: "4300.0000", previousCertificates: "22750.0000", currentPaymentDue: "16950.0000",
    });
    const secondRaised = await applications.raise(owner(), { id: second.id });
    const lines = await raw<{ name: string; unit_price: string }[]>`
      select name, unit_price from public.invoice_line where invoice_id = ${secondRaised.invoiceId} order by unit_price desc`;
    expect(lines.reduce((sum, l) => sum + Math.round(Number(l.unit_price) * 100), 0)).toBe(1_695_000);
    void rough; void fixtures;
  });

  it("refuses to bill a project two ways, and refuses a draft whose schedule does not add up", async () => {
    const { project, rough } = await fitout();
    await projects.planDraw(owner(), { projectId: project.id, phaseId: rough.id, label: "Deposit", amount: "1000" });
    await expect(applications.create(owner(), { projectId: project.id, periodTo: "2026-11-30" }))
      .rejects.toThrow(/billed by draws/);

    const other = await projects.create(owner(), {
      customerId, propertyId, name: "Short schedule", contractValue: "50000",
    });
    await projects.addPhase(owner(), { projectId: other.id, name: "Only phase", billingValue: "30000" });
    const draft = await applications.create(owner(), { projectId: other.id, periodTo: "2026-11-30" });
    expect(draft.totals).toBeNull();
    expect(draft.problems[0]).toContain("$20,000.00 short");
    await expect(applications.raise(owner(), { id: draft.id })).rejects.toThrow(/short/);
    await expect(projects.planDraw(owner(), { projectId: other.id, label: "Deposit", amount: "1000" }))
      .rejects.toThrow(/billed by applications/);
  });

  it("is money: a dispatcher can neither read nor raise one", async () => {
    const { project } = await fitout();
    await expect(applications.list(as(["dispatcher"]), { projectId: project.id })).rejects.toBeInstanceOf(PermissionError);
    await expect(applications.create(as(["dispatcher"]), { projectId: project.id, periodTo: "2026-11-30" }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("notices and waivers", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("are recorded against the payments the project billed, with a checklist that states only what is on file", async () => {
    const { project, rough } = await fitout();
    const app = await applications.create(owner(), { projectId: project.id, periodTo: "2026-11-30" });
    await applications.updateDraft(owner(), { id: app.id, lines: [{ id: app.lines[0]!.id, workThisPeriod: "20000" }] });
    const raised = await applications.raise(owner(), { id: app.id });

    await liens.record(owner(), {
      projectId: project.id, kind: "notice", direction: "sent", title: "Preliminary notice",
      partyName: "Hillcrest Partners", onDate: "2026-11-01",
    });
    const waiver = await liens.record(owner(), {
      projectId: project.id, kind: "waiver", direction: "sent", condition: "conditional", scope: "progress",
      title: "Conditional waiver on progress payment", partyName: "Hillcrest Partners",
      onDate: "2026-11-30", throughDate: "2026-11-30", amount: "17000", invoiceId: raised.invoiceId,
      document: { fileName: "waiver.png", bytes: PNG },
    });
    expect(waiver.documents).toHaveLength(1);
    expect(waiver.invoiceNumber).not.toBeNull();

    const listed = await liens.list(owner(), { projectId: project.id });
    expect(listed.records).toHaveLength(2);
    expect(listed.disclaimer).toMatch(/not something this product decides/);
    expect(listed.checklist).toEqual([expect.objectContaining({
      invoiceId: raised.invoiceId, amount: "18000.0000", paid: false,
      conditional: [waiver.id], unconditional: [],
      notes: ["The conditional waiver from Hillcrest Partners is for $17,000.00, and this payment is $18,000.00."],
    })]);

    await expect(liens.record(owner(), {
      projectId: project.id, kind: "waiver", direction: "sent", title: "Waiver", partyName: "X", onDate: "2026-11-30",
    })).rejects.toThrow(/conditional or unconditional/);

    const elsewhere = await projects.create(owner(), { customerId, propertyId, name: "Other", contractValue: "1000" });
    await expect(liens.record(owner(), {
      projectId: elsewhere.id, kind: "waiver", direction: "sent", condition: "unconditional", scope: "final",
      title: "Final", partyName: "X", onDate: "2026-11-30", invoiceId: raised.invoiceId,
    })).rejects.toThrow(/not a payment this project billed/);
    void rough;
  });
});

run("the contract guard reads the same billed total", () => {
  it("refuses cutting the contract below the work certified on an application", async () => {
    const { project } = await fitout();
    const app = await applications.create(owner(), { projectId: project.id, periodTo: "2026-11-30" });
    await applications.updateDraft(owner(), { id: app.id, lines: [{ id: app.lines[0]!.id, workThisPeriod: "60000" }, { id: app.lines[1]!.id, workThisPeriod: "30000" }] });
    await applications.raise(owner(), { id: app.id });
    await expect(projects.update(owner(), { id: project.id, contractValue: "80000" }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
