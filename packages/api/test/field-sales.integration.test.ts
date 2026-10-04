import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { agents as coreAgents, field, PermissionError, type Actor, type Permission } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as fieldPayments from "../src/services/field-payments";
import * as fieldSales from "../src/services/field-sales";
import * as estimates from "../src/services/estimates";
import * as billing from "../src/services/billing";
import * as jobBilling from "../src/services/job-billing";
import * as dispatchSvc from "../src/services/dispatch";
import * as tasks from "../src/services/tasks";
import * as portalSettings from "../src/services/portal-settings";
import * as payroll from "../src/services/payroll";
import * as laborSettings from "../src/services/labor-settings";
import * as knowledge from "../src/services/knowledge";
import * as agents from "../src/services/agents";
import * as agentField from "../src/services/agent-field";
import * as ai from "../src/services/ai";
import type * as financing from "../src/services/financing";
import "../src/ai/index";
import type { AiContent, AiProvider, CompletionOutcome, CompletionRequest, ModelListOutcome, ModelRate } from "../src/ai/provider";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, resetOrg, companyToday } from "./helpers";
import { fakeLender, type FakeLender } from "./financing-fake";

/**
 * SELLING AND CLOSING ON SITE
 *
 * The kitchen table, from the phone's queue: good, better and best built from
 * the price book with the member's discount shown, the customer's choice and
 * signature taken on the glass, the invoice raised and signed for, money and
 * a tip taken, a cash tip kept, the office's tasks taken and finished, a
 * lender's link, and the field assistant answering from the company's own
 * records. Each through the real sync and the real services, because every
 * rule that matters here (the figure the customer signed is the figure
 * written; a technician carries a customer's yes and never gives one; a tip
 * is split the way the portal splits it) lives where they meet.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("field-sales:org");
const OWNER = fixtureId("field-sales:owner");
const RAY = fixtureId("field-sales:ray");
const SAM = fixtureId("field-sales:sam");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (userId: string, technicianId: string, revocations: Permission[] = []): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"], technicianId, revocations }, db: db(),
});
const ray = (revocations: Permission[] = []) => as(RAY, rayTech, revocations);
const sam = () => as(SAM, samTech);

let rayTech = "";
let samTech = "";
let customerId = "";
let propertyId = "";
const book: Record<"heater" | "tank" | "diagnostic" | "kit", { itemId: string; versionId: string; price: string }> = {} as never;

async function technician(userId: string, name: string): Promise<string> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@field-sales.test`;
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return tech!.id as string;
}

async function item(key: keyof typeof book, input: {
  code: string; name: string; price: string; kind: string; feeRole?: string; cost?: string;
  components?: Array<{ itemId: string; quantity: number }>;
}) {
  const [row] = await raw`insert into public.price_book_item (organization_id, code, kind, fee_role)
    values (${ORG}, ${input.code}, ${input.kind}::item_kind, ${input.feeRole ?? null}::price_book_fee_role) returning id`;
  const [version] = await raw`insert into public.price_book_item_version
    (organization_id, item_id, version, name, price, cost, components, effective_from)
    values (${ORG}, ${row!.id}, 1, ${input.name}, ${input.price}, ${input.cost ?? null},
            ${raw.json((input.components ?? []) as never)}, now() - interval '30 days') returning id`;
  book[key] = { itemId: row!.id, versionId: version!.id, price: input.price };
}

async function visitFor(technicianIds: string[]) {
  const [job] = await raw`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId}, 'scheduled', 'No hot water')
    returning id, number`;
  const [visit] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'working', now(), now() + interval '2 hours') returning id`;
  for (const technicianId of technicianIds) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${technicianId})`;
  }
  return { jobId: job!.id as string, jobNumber: job!.number as number, visitId: visit!.id as string };
}

/** One phone's batch, numbered from one on a fresh device, as the phone would send it. */
async function send(ctx: ServiceContext, ops: Array<{ kind: field.OperationKind; subjectId?: string; payload?: Record<string, unknown>; occurredAt?: Date }>) {
  const device = await fieldOps.register(ctx, { installationId: `phone-${crypto.randomUUID()}` });
  const result = await fieldOps.sync(ctx, {
    deviceId: device.deviceId,
    operations: ops.map((op, i) => ({
      clientId: crypto.randomUUID(),
      sequence: i + 1,
      kind: op.kind,
      ...(op.subjectId ? { subjectId: op.subjectId } : {}),
      occurredAt: (op.occurredAt ?? new Date(Date.now() - (ops.length - i) * 60_000)).toISOString(),
      payload: op.payload ?? {},
    })),
  });
  return { results: result.results, deviceId: device.deviceId };
}

/** The member the visit is priced for: ten per cent off, and the diagnostic fee waived. */
const MEMBER = { rate: "0.1", waivesDiagnosticFee: true, waivesAfterHoursRate: false };

/** Good and best, built on the phone, with ids the phone made. */
function goodAndBest() {
  const line = (key: keyof typeof book, extra: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), priceBookItemId: book[key].itemId, versionId: book[key].versionId,
    name: key, quantity: "1", unitPrice: book[key].price, taxable: false, ...extra,
  });
  const good = { id: crypto.randomUUID(), name: "Repair", isRecommended: false, lines: [line("diagnostic"), line("tank")] };
  const best = {
    id: crypto.randomUUID(), name: "Replace", isRecommended: true,
    lines: [line("diagnostic"), line("heater"), line("tank", { isOptional: true, isSelected: false })],
  };
  return { good, best };
}

/** What the phone shows for an option, with the optional lines the customer ticked. */
function phoneTotal(option: { lines: Array<Record<string, unknown>> }, ticked: string[] = []): string {
  const keyOf = (name: unknown) => name as keyof typeof book;
  return field.priceOnSite(option.lines.map((l) => ({
    quantity: String(l["quantity"]), unitPrice: String(l["unitPrice"]), taxable: false, taxRate: "0",
    isOptional: l["isOptional"] === true, isSelected: l["isOptional"] === true ? ticked.includes(String(l["id"])) : false,
    itemKind: keyOf(l["name"]) === "diagnostic" ? "fee" : keyOf(l["name"]) === "tank" ? "material" : "service",
    feeRole: keyOf(l["name"]) === "diagnostic" ? "diagnostic" : null,
  })), MEMBER).totals.total;
}

/* --------------------------------------------------------- the fake model */

const requests: CompletionRequest[] = [];
let script: (request: CompletionRequest) => AiContent[] = () => [{ type: "text", text: "nothing scripted" }];
const provider: AiProvider = {
  name: "anthropic",
  toolCallIdentity: { kind: "vendor" },
  defaultModel: "fake-model",
  rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
  async complete(request): Promise<CompletionOutcome> {
    requests.push(request);
    const content = script(request);
    return {
      ok: true,
      completion: {
        model: request.model, content,
        stop: content.some((c) => c.type === "toolCall") ? "toolUse" : "end",
        usage: { inputTokens: 300, outputTokens: 60, cachedInputTokens: null },
      },
    };
  },
  async models(): Promise<ModelListOutcome> {
    return { ok: true, models: [{ id: "fake-model", label: "Fake" }] };
  },
};
const aiDeps = (): ai.AiDeps => ({ readSecret: async () => "sk-test-not-a-key", provider });
const answer = (input: Record<string, unknown>, name = "answer"): AiContent[] =>
  [{ type: "toolCall", callId: `call_${name}`, name, input }];
const promptOf = (request: CompletionRequest): string =>
  request.messages.flatMap((m) => m.content).map((c) => (c.type === "text" ? c.text : "")).join("\n");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Kitchen Table Heating", slug: "field-sales" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  rayTech = await technician(RAY, "Ray Nunez");
  samTech = await technician(SAM, "Sam Ortiz");

  const [c] = await raw`insert into public.customer (organization_id, name, phone)
    values (${ORG}, 'Nina Patel', '+15125550141') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Elm St', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;

  await item("heater", { code: "WH-50", name: "Water heater, 50 gallon, installed", price: "1800.0000", kind: "service", cost: "900.0000" });
  await item("tank", { code: "EXP-2", name: "Expansion tank", price: "180.0000", kind: "material", cost: "60.0000" });
  await item("diagnostic", { code: "DIAG", name: "Diagnostic visit", price: "89.0000", kind: "fee", feeRole: "diagnostic" });
  await item("kit", {
    code: "TUNE", name: "Flush and tune kit", price: "250.0000", kind: "service",
    components: [{ itemId: book.tank.itemId, quantity: 1 }, { itemId: book.diagnostic.itemId, quantity: 1 }],
  });

  const [plan] = await raw`insert into public.agreement_plan
    (organization_id, name, code, price, billing_frequency, discount_rate, waives_diagnostic_fee)
    values (${ORG}, 'Comfort Club', 'cc', '199.0000', 'annual', '0.1', true) returning id`;
  await raw`insert into public.agreement
    (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency, discount_rate)
    values (${ORG}, ${plan!.id}, ${customerId}, 'active', current_date - 30, '199.0000', 'annual', '0.1')`;

  await portalSettings.set(owner(), { tipping: { enabled: true, presets: [15, 20, 25] } });
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${RAY}, ${SAM})`;
  await raw.end();
});

/* -------------------------------------------------------------- estimates */

run("an estimate built on the phone", () => {
  it("is written with the phone's ids, at the prices it showed, with the member's discount", async () => {
    const { visitId, jobId } = await visitFor([rayTech]);
    const estimateId = crypto.randomUUID();
    const { good, best } = goodAndBest();
    const { results } = await send(ray(), [{
      kind: "estimate.create", subjectId: estimateId,
      payload: { visitId, title: "No hot water", options: [good, best] },
    }]);
    expect(results[0]).toMatchObject({ status: "applied", rejection: null });

    const [estimate] = await raw`select status, job_id, customer_id, property_id from public.estimate where id = ${estimateId}`;
    expect(estimate).toMatchObject({ status: "draft", job_id: jobId, customer_id: customerId, property_id: propertyId });
    const options = await raw`select id, total::text from public.estimate_option where estimate_id = ${estimateId} order by sort_order`;
    expect(options.map((o) => o.id)).toEqual([good.id, best.id]);
    // The repair: the diagnostic fee waived for a member, ten per cent off the tank.
    expect(options[0]!.total).toBe(phoneTotal(good));
    expect(options[0]!.total).toBe("162.0000");
    expect(options[1]!.total).toBe(phoneTotal(best));
    const [diagnostic] = await raw`select member_discount_amount::text from public.estimate_line where id = ${good.lines[0]!.id}`;
    expect(diagnostic!.member_discount_amount).toBe("89.0000");
  });

  it("is on the phone's day for the customer to see, with prices and never a cost or margin", async () => {
    const { visitId } = await visitFor([rayTech]);
    const estimateId = crypto.randomUUID();
    const { good, best } = goodAndBest();
    await send(ray(), [{ kind: "estimate.create", subjectId: estimateId, payload: { visitId, options: [good, best] } }]);
    const device = await fieldOps.register(ray(), { installationId: `day-${crypto.randomUUID()}` });
    const day = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 2 });
    const visit = day.visits.find((v) => v.id === visitId)!;
    const shown = visit.estimates.find((e) => e.id === estimateId)!;
    expect(shown.options.map((o) => o.id).sort()).toEqual([good.id, best.id].sort());
    expect(JSON.stringify(visit.estimates)).not.toMatch(/cost|margin/i);
    expect(visit.member).toEqual({ planName: "Comfort Club", rate: "0.100000", waivesDiagnosticFee: true, waivesAfterHoursRate: false });
    const kit = day.priceBook.find((entry) => entry.id === book.kit.itemId)!;
    expect(kit.components).toEqual([{ name: "Expansion tank", quantity: 1 }, { name: "Diagnostic visit", quantity: 1 }]);
    expect(day.abilities).toMatchObject({ writeEstimates: true, presentEstimates: true, raiseInvoices: true, takePayments: true });
    expect(day.abilities.tipping).toEqual({ enabled: true, presets: [15, 20, 25] });
  });

  it("writes two estimates and two invoices from one send, whatever key the send itself carried", async () => {
    const { visitId } = await visitFor([rayTech]);
    const first = goodAndBest();
    const second = goodAndBest();
    const lines = [crypto.randomUUID(), crypto.randomUUID()];
    const device = await fieldOps.register(ray(), { installationId: `batch-${crypto.randomUUID()}` });
    const op = (sequence: number, kind: field.OperationKind, subjectId: string, payload: Record<string, unknown>) => ({
      clientId: crypto.randomUUID(), sequence, kind, subjectId, occurredAt: new Date(Date.now() - (10 - sequence) * 60_000).toISOString(), payload,
    });
    const result = await fieldOps.sync({ ...ray(), idempotencyKey: `sync-${crypto.randomUUID()}` }, {
      deviceId: device.deviceId,
      operations: [
        op(1, "estimate.create", crypto.randomUUID(), { visitId, options: [first.good] }),
        op(2, "estimate.create", crypto.randomUUID(), { visitId, options: [second.best] }),
        op(3, "visit.add_line", visitId, { lineId: lines[0], kind: "part", name: "Fitting", quantity: "1", unitPrice: "10.0000" }),
        op(4, "visit.add_line", visitId, { lineId: lines[1], kind: "part", name: "Valve", quantity: "1", unitPrice: "20.0000" }),
        op(5, "invoice.raise", crypto.randomUUID(), { visitId, source: "work", jobLineIds: [lines[0]], shownTotal: "9.00" }),
        op(6, "invoice.raise", crypto.randomUUID(), { visitId, source: "work", jobLineIds: [lines[1]], shownTotal: "18.00" }),
      ],
    });
    expect(result.results.map((r) => [r.status, r.rejection])).toEqual(Array(6).fill(["applied", null]));
  });

  it("refuses a price from a price book more than a week old, rather than writing a figure nobody can stand behind", async () => {
    const { visitId } = await visitFor([rayTech]);
    const [stale] = await raw`insert into public.price_book_item_version
      (organization_id, item_id, version, name, price, effective_from, effective_to)
      values (${ORG}, ${book.tank.itemId}, 99, 'Expansion tank', '100.0000', now() - interval '90 days', now() - interval '60 days')
      returning id`;
    const { good } = goodAndBest();
    good.lines[1]!.versionId = stale!.id;
    const { results } = await send(ray(), [{ kind: "estimate.create", subjectId: crypto.randomUUID(), payload: { visitId, options: [good] } }]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[0]!.rejection).toMatch(/more than a week old/);
  });
});

run("the customer's choice and signature on the glass", () => {
  async function built() {
    const { visitId, jobId } = await visitFor([rayTech, samTech]);
    const estimateId = crypto.randomUUID();
    const { good, best } = goodAndBest();
    await send(ray(), [{ kind: "estimate.create", subjectId: estimateId, payload: { visitId, options: [good, best] } }]);
    return { visitId, jobId, estimateId, good, best };
  }

  it("approves the option they chose, with the extras they ticked, signed when they signed", async () => {
    const { visitId, estimateId, best } = await built();
    const uploadId = crypto.randomUUID();
    const signedAt = new Date(Date.now() - 20 * 60_000);
    const tank = String(best.lines[2]!.id);
    const { results } = await send(ray(), [
      { kind: "signature.capture", subjectId: visitId, payload: { uploadId, contentType: "image/png", caption: "Signed by Nina Patel" }, occurredAt: signedAt },
      { kind: "estimate.approve", subjectId: estimateId, occurredAt: signedAt, payload: {
        visitId, optionId: best.id, selectedLineIds: [tank], signerName: "Nina Patel",
        signatureUploadId: uploadId, shownTotal: phoneTotal(best, [tank]),
      } },
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);

    const [estimate] = await raw`select status, selected_option_id, signer_name, decided_at from public.estimate where id = ${estimateId}`;
    expect(estimate).toMatchObject({ status: "approved", selected_option_id: best.id, signer_name: "Nina Patel" });
    const [signature] = await raw`select upload_id, signed_at, selected_option_id from public.document_signature
      where subject = 'estimate' and subject_id = ${estimateId}`;
    expect(signature!.upload_id).toBe(uploadId);
    expect(Math.abs(new Date(signature!.signed_at).getTime() - signedAt.getTime())).toBeLessThan(1000);
    const [audit] = await raw`select after->>'capturedVia' as via from public.audit_log
      where entity_id = ${estimateId} and action = 'estimate.approved'`;
    expect(audit!.via).toBe("in_person");
    // The office sees it was signed on the phone; the drawn image follows once the phone sends its bytes.
    expect(await fieldSales.signatureOn(owner(), { subject: "estimate", subjectId: estimateId })).toEqual({
      signerName: "Nina Patel", signedAt: new Date(signature!.signed_at).toISOString(), onSite: true, imageKey: null,
    });
  });

  it("refuses a signature over a figure the customer was not shown, and says so", async () => {
    const { visitId, estimateId, best } = await built();
    const { results } = await send(ray(), [{ kind: "estimate.approve", subjectId: estimateId, payload: {
      visitId, optionId: best.id, selectedLineIds: [], signerName: "Nina Patel",
      signatureUploadId: crypto.randomUUID(), shownTotal: "1500.00",
    } }]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[0]!.rejection).toMatch(/^The customer was shown \$1,500\.00, and this option/);
    const [estimate] = await raw`select status from public.estimate where id = ${estimateId}`;
    expect(estimate!.status).toBe("draft");
  });

  it("is the customer's yes: no signature, no approval, and only on the technician's own day", async () => {
    const { visitId, estimateId, good } = await built();
    const shownTotal = phoneTotal(good);
    const unsigned = await send(ray(), [{ kind: "estimate.approve", subjectId: estimateId, payload: {
      visitId, optionId: good.id, shownTotal,
    } }]);
    expect(unsigned.results[0]!.rejection).toBe("The customer has to sign and give their name for this to count as their yes.");

    const elsewhere = await visitFor([samTech]);
    const notMine = await send(ray(), [{ kind: "estimate.approve", subjectId: estimateId, payload: {
      visitId: elsewhere.visitId, optionId: good.id, shownTotal, signerName: "Nina Patel", signatureUploadId: crypto.randomUUID(),
    } }]);
    expect(notMine.results[0]!.rejection).toBe("That visit is not on your day, so you cannot take a signature for it.");

    const withoutPresent = await send(ray(["estimate:present"]), [{ kind: "estimate.approve", subjectId: estimateId, payload: {
      visitId: elsewhere.visitId, optionId: good.id, shownTotal, signerName: "Nina Patel", signatureUploadId: crypto.randomUUID(),
    } }]);
    expect(withoutPresent.results[0]!.rejection).toMatch(/may not take a customer's signature/);
  });

  it("records a no, with why, from the customer's own mouth", async () => {
    const { visitId, estimateId } = await built();
    const { results } = await send(ray(), [{ kind: "estimate.decline", subjectId: estimateId, payload: { visitId, reason: "Getting a second quote" } }]);
    expect(results[0]!.status).toBe("applied");
    const [estimate] = await raw`select status, decline_reason from public.estimate where id = ${estimateId}`;
    expect(estimate).toMatchObject({ status: "declined", decline_reason: "Getting a second quote" });
  });
});

/* --------------------------------------------------------------- invoices */

run("the invoice, raised and signed for on site, and paid", () => {
  it("bills the option they signed for, issues it, takes their signature and cash with a tip split between the crew", async () => {
    const { visitId, jobId } = await visitFor([rayTech, samTech]);
    const estimateId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const { good, best } = goodAndBest();
    const total = phoneTotal(best);
    const upload = crypto.randomUUID();
    const { results } = await send(ray(), [
      { kind: "estimate.create", subjectId: estimateId, payload: { visitId, options: [good, best] } },
      { kind: "estimate.approve", subjectId: estimateId, payload: {
        visitId, optionId: best.id, selectedLineIds: [], signerName: "Nina Patel", signatureUploadId: crypto.randomUUID(), shownTotal: total,
      } },
      { kind: "signature.capture", subjectId: visitId, payload: { uploadId: upload, contentType: "image/png" } },
      { kind: "invoice.raise", subjectId: invoiceId, payload: {
        visitId, source: "estimate", estimateId, shownTotal: total, signerName: "Nina Patel", signatureUploadId: upload,
      } },
      { kind: "payment.collect", subjectId: visitId, payload: { method: "cash", amount: total, tipAmount: "40.00", invoiceId } },
    ]);
    expect(results.map((r) => [r.status, r.rejection])).toEqual(Array(5).fill(["applied", null]));

    const [invoice] = await raw`select status, total::text, balance::text, job_id from public.invoice where id = ${invoiceId}`;
    expect(invoice).toMatchObject({ status: "paid", total, balance: "0.0000", job_id: jobId });
    const [estimate] = await raw`select status from public.estimate where id = ${estimateId}`;
    expect(estimate!.status).toBe("converted");
    const [signature] = await raw`select signer_name, upload_id from public.document_signature where subject = 'invoice' and subject_id = ${invoiceId}`;
    expect(signature).toMatchObject({ signer_name: "Nina Patel", upload_id: upload });

    const [payment] = await raw`select p.amount::text, p.tip_amount::text from public.payment p
      join public.payment_allocation a on a.payment_id = p.id where a.invoice_id = ${invoiceId}`;
    expect(payment).toMatchObject({ amount: total, tip_amount: "40.0000" });
    const shares = await raw`select technician_id, amount::text from public.tip_share where invoice_id = ${invoiceId} order by technician_id`;
    expect(shares.map((s) => s.amount)).toEqual(["20.0000", "20.0000"]);
    expect(shares.map((s) => s.technician_id).sort()).toEqual([rayTech, samTech].sort());
  });

  it("bills parts recorded on the same phone before it had a signal, at the member's price", async () => {
    const { visitId } = await visitFor([rayTech]);
    const lineId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    // Ten per cent off the tank for a member, as the phone works it out.
    const shown = field.priceOnSite([{ quantity: "2", unitPrice: "180.00", taxable: true, taxRate: "0", itemKind: "material" }], MEMBER).totals.total;
    const { results } = await send(ray(), [
      { kind: "visit.add_line", subjectId: visitId, payload: {
        lineId, kind: "part", priceBookItemVersionId: book.tank.versionId, name: "Expansion tank", quantity: "2", unitPrice: "180.0000",
      } },
      { kind: "invoice.raise", subjectId: invoiceId, payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: shown } },
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    const [invoice] = await raw`select status, total::text from public.invoice where id = ${invoiceId}`;
    expect(invoice).toMatchObject({ status: "open", total: "324.0000" });
    const [line] = await raw`select invoice_line_id from public.job_line where id = ${lineId}`;
    expect(line!.invoice_line_id).not.toBeNull();
  });

  it("keeps it as a draft for the office, said, when the customer was shown another figure", async () => {
    const { visitId } = await visitFor([rayTech]);
    const lineId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const { results } = await send(ray(), [
      { kind: "visit.add_line", subjectId: visitId, payload: {
        lineId, kind: "part", priceBookItemVersionId: book.tank.versionId, name: "Expansion tank", quantity: "1", unitPrice: "180.0000",
      } },
      { kind: "invoice.raise", subjectId: invoiceId, payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "150.00" } },
    ]);
    expect(results[1]!.status).toBe("conflicted");
    expect(results[1]!.conflict).toBe(
      "The customer was shown $150.00 and the office's prices make it $162.00, so the invoice was kept as a draft for the office to check before it is sent.",
    );
    const [invoice] = await raw`select status from public.invoice where id = ${invoiceId}`;
    expect(invoice!.status).toBe("draft");
    const listed = await fieldOps.conflicts(owner(), { limit: 50, includeResolved: false });
    expect(listed.data.some((c) => c.kind === "invoice.raise")).toBe(true);
  });

  it("needs the narrow permission, the technician's own visit, and work not already billed", async () => {
    const mine = await visitFor([rayTech]);
    const lineId = crypto.randomUUID();
    await send(ray(), [{ kind: "visit.add_line", subjectId: mine.visitId, payload: {
      lineId, kind: "part", name: "Fitting", quantity: "1", unitPrice: "12.0000",
    } }]);
    const raise = (visitId: string) => ({
      kind: "invoice.raise" as const, subjectId: crypto.randomUUID(),
      // Twelve dollars, less the member's ten per cent.
      payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "10.80" },
    });
    expect((await send(ray(["invoice:raise_on_site"]), [raise(mine.visitId)])).results[0]!.rejection)
      .toBe("Your account may not raise invoices. Ask the office to raise it.");
    expect((await send(sam(), [raise(mine.visitId)])).results[0]!.rejection)
      .toBe("That visit is not on your day, so you cannot invoice it.");
    expect((await send(ray(), [raise(mine.visitId)])).results[0]!.status).toBe("applied");
    expect((await send(ray(), [raise(mine.visitId)])).results[0]!.rejection).toMatch(/already billed/);
  });

  it("takes a tip only when the company takes tips", async () => {
    const { visitId } = await visitFor([rayTech]);
    await portalSettings.set(owner(), { tipping: { enabled: false, presets: [15, 20, 25] } });
    try {
      const refused = await send(ray(), [{ kind: "payment.collect", subjectId: visitId, payload: { method: "cash", amount: "50.00", tipAmount: "5" } }]);
      expect(refused.results[0]!.rejection).toBe("This company does not take tips with a payment. Record the payment without one.");
      const plain = await send(ray(), [{ kind: "payment.collect", subjectId: visitId, payload: { method: "cash", amount: "50.00" } }]);
      expect(plain.results[0]!.status).toBe("applied");
    } finally {
      await portalSettings.set(owner(), { tipping: { enabled: true, presets: [15, 20, 25] } });
    }
  });

  it("offers the lender's link for what is owing, only with a lender connected", async () => {
    const lender: FakeLender = fakeLender();
    const deps: financing.FinancingDeps = { readSecret: async () => "api-token-not-real", provider: lender };
    const { visitId } = await visitFor([rayTech]);
    const lineId = crypto.randomUUID();
    await send(ray(), [
      { kind: "visit.add_line", subjectId: visitId, payload: { lineId, kind: "part", name: "Boiler", quantity: "1", unitPrice: "4200.0000" } },
      { kind: "invoice.raise", subjectId: crypto.randomUUID(), payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "3780.00" } },
    ]);
    await expect(fieldPayments.financingLink(ray(), { id: visitId, text: false }, deps)).rejects.toThrow(/has not connected a lender/);
    await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
      values (${ORG}, 'financing', 'wisetack', 'connected', 'TEST_LENDER_TOKEN', ${raw.json({ merchantId: "m_1", plans: ["60@17.9"] } as never)})`;
    try {
      const link = await fieldPayments.financingLink(ray(), { id: visitId, text: false }, deps);
      expect(link).toMatchObject({ amount: "3780.0000", lender: "Wisetack", texted: false, reason: null });
      expect(link.url).toMatch(/^https?:\/\//);
      await expect(fieldPayments.financingLink(sam(), { id: visitId, text: false }, deps)).rejects.toThrow(PermissionError);
    } finally {
      await raw`delete from public.financing_application where organization_id = ${ORG}`;
      await raw`delete from public.integration_connection where organization_id = ${ORG} and capability = 'financing'`;
    }
  });
});

/* ------------------------------------------------------- tips and the queue */

/**
 * SALES TAX ON AN INVOICE RAISED ON SITE, AGAINST ONE THE OFFICE RAISES
 *
 * M11 said invoices carry no sales tax yet, which stopped being true when the
 * rate went onto each line. What is true is narrower, and these pin it: a
 * rate is on an invoice only where a person typed one (on an estimate, on the
 * phone or in the office, and carried onto the invoice as applied; or on the
 * job's "Bill this job" screen), because nothing in the product decides a
 * company's rate. On site and in the office the rule is the same.
 */
run("sales tax on an invoice raised on site", () => {
  const RATE = "0.0825";

  /** The estimate the phone writes, taxable at the rate typed on its builder. */
  function taxedOption() {
    const line = (key: keyof typeof book) => ({
      id: crypto.randomUUID(), priceBookItemId: book[key].itemId, versionId: book[key].versionId,
      name: key, quantity: "1", unitPrice: book[key].price, taxable: true,
    });
    return { id: crypto.randomUUID(), name: "Replace", isRecommended: true, lines: [line("heater"), line("tank")] };
  }

  it("charges the tax the estimate was written with, the same as the office's conversion of the same estimate", async () => {
    const option = taxedOption();
    // What the customer is shown on the phone, tax included.
    const shown = field.priceOnSite(option.lines.map((l) => ({
      quantity: l.quantity, unitPrice: l.unitPrice, taxable: true, taxRate: RATE,
      itemKind: l.name === "tank" ? "material" : "service",
    })), MEMBER).totals.total;

    // On site: written on the phone, signed for, billed and issued from the visit.
    const { visitId } = await visitFor([rayTech]);
    const estimateId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const { results } = await send(ray(), [
      { kind: "estimate.create", subjectId: estimateId, payload: { visitId, taxRate: RATE, options: [option] } },
      { kind: "estimate.approve", subjectId: estimateId, payload: {
        visitId, optionId: option.id, selectedLineIds: [], signerName: "Nina Patel", signatureUploadId: crypto.randomUUID(), shownTotal: shown,
      } },
      { kind: "invoice.raise", subjectId: invoiceId, payload: { visitId, source: "estimate", estimateId, shownTotal: shown } },
    ]);
    expect(results.map((r) => [r.status, r.rejection])).toEqual(Array(3).fill(["applied", null]));
    const [onSite] = await raw`select status, tax_total::text, total::text from public.invoice where id = ${invoiceId}`;
    expect(onSite).toMatchObject({ status: "open", total: shown });
    expect(Number(onSite!.tax_total)).toBeGreaterThan(0);

    // In the office: the same estimate written by hand, approved, converted.
    const written = await estimates.create(owner(), {
      customerId, propertyId, taxRate: RATE,
      options: [{
        name: "Replace", isRecommended: true,
        lines: option.lines.map((l) => ({
          priceBookItemId: l.priceBookItemId, name: l.name, quantity: "1", unitPrice: l.unitPrice,
          discountAmount: "0", taxable: true, isOptional: false, isSelected: false,
        })),
      }],
    } as Parameters<typeof estimates.create>[1]);
    const [officeOption] = await raw<{ id: string }[]>`select id from public.estimate_option where estimate_id = ${written.id}`;
    await estimates.approve(owner(), { id: written.id, optionId: officeOption!.id, selectedLineIds: [], signerName: "Nina Patel", capturedVia: "phone" } as Parameters<typeof estimates.approve>[1]);
    const converted = await estimates.convert(owner(), { id: written.id, createJob: false, createInvoice: true } as Parameters<typeof estimates.convert>[1]);
    const [office] = await raw`select tax_total::text, total::text from public.invoice where id = ${converted.invoiceId}`;

    expect(office!.tax_total).toBe(onSite!.tax_total);
    expect(office!.total).toBe(onSite!.total);
    // And every line carries the rate it was charged at, on site as in the office.
    const rates = (id: string) => raw`select tax_rate::text, tax_amount::text from public.invoice_line where invoice_id = ${id} order by sort_order`;
    expect(await rates(invoiceId)).toEqual(await rates(converted.invoiceId as string));
    expect((await rates(invoiceId)).every((l) => l.tax_rate === "0.082500")).toBe(true);
  });

  it("charges none on work recorded and billed on site, exactly as the office's ordinary invoice for the same work charges none", async () => {
    const { visitId, jobId } = await visitFor([rayTech]);
    const lineId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const { results } = await send(ray(), [
      { kind: "visit.add_line", subjectId: visitId, payload: {
        lineId, kind: "part", priceBookItemVersionId: book.tank.versionId, name: "Expansion tank", quantity: "1", unitPrice: "180.0000",
      } },
      // The phone's figure for a taxable part, at the rate nothing in the product holds: none.
      { kind: "invoice.raise", subjectId: invoiceId, payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "162.00" } },
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    const [onSite] = await raw`select tax_total::text, total::text from public.invoice where id = ${invoiceId}`;
    expect(onSite).toEqual({ tax_total: "0.0000", total: "162.0000" });
    const [taxable] = await raw`select taxable from public.invoice_line where invoice_id = ${invoiceId}`;
    expect(taxable!.taxable).toBe(true);

    const office = await billing.create(owner(), {
      customerId, jobId,
      lines: [{ priceBookItemId: book.tank.itemId, name: "Expansion tank", quantity: "1", unitPrice: "180.0000", discountAmount: "0", taxable: true }],
    } as Parameters<typeof billing.create>[1]);
    expect(office.taxTotal).toBe(onSite!.tax_total);
    expect(office.total).toBe(onSite!.total);
  });

  it("charges tax on the job's own work in the office only where somebody typed a rate, which the phone has no box for", async () => {
    const { visitId, jobId } = await visitFor([rayTech]);
    const lineId = crypto.randomUUID();
    await send(ray(), [{ kind: "visit.add_line", subjectId: visitId, payload: {
      lineId, kind: "part", priceBookItemVersionId: book.tank.versionId, name: "Expansion tank", quantity: "1", unitPrice: "180.0000",
    } }]);
    const untyped = await jobBilling.preview(owner(), { jobId });
    expect(untyped.payers.reduce((sum, p) => sum + Number(p.taxTotal), 0)).toBe(0);
    const typed = await jobBilling.preview(owner(), { jobId, taxRate: RATE });
    expect(typed.payers.reduce((sum, p) => sum + Number(p.taxTotal), 0)).toBeGreaterThan(0);
  });
});

run("a cash tip kept, and the office's tasks", () => {
  it("records a cash tip on the technician's own pay statement, already in their hand", async () => {
    await laborSettings.setPolicy(owner(), {
      label: "Federal", timeZone: ZONE, weekStartsOn: 1, dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
      overtimeMultiplier: "1.5", doubleTimeMultiplier: "2", onCallTreatment: "separate_rate_not_hours_worked",
      note: "Forty hours a week at time and a half.",
    });
    const { visitId, jobNumber } = await visitFor([rayTech]);
    const tipId = crypto.randomUUID();
    const { results } = await send(ray(), [{
      kind: "tip.record", subjectId: visitId, occurredAt: new Date("2026-01-07T18:00:00Z"),
      payload: { tipId, amount: "20.00", note: "For you, thanks" },
    }]);
    expect(results[0]!.status).toBe("applied");
    const [tip] = await raw`select technician_id, amount::text from public.cash_tip where id = ${tipId}`;
    expect(tip).toMatchObject({ technician_id: rayTech, amount: "20.0000" });

    const period = await payroll.declarePeriod(owner(), { label: "Fortnight to 18 January", startDate: "2026-01-05", weeks: 2 });
    const register = await payroll.register(owner(), { periodId: period.id });
    const row = register.rows.find((r) => r.technicianName === "Ray Nunez")!;
    expect(row.lines.filter((l) => l.kind === "cash_tip"))
      .toEqual([expect.objectContaining({ label: `Cash tip kept, job ${jobNumber}`, amount: "20.0000" })]);
  });

  it("takes a task, refuses the second person to take it, and finishes it", async () => {
    const task = await tasks.create(owner(), { title: "Call Nina back about the thermostat" });
    const day = await dispatchSvc.snapshot(ray(), {
      deviceId: (await fieldOps.register(ray(), { installationId: `tasks-${crypto.randomUUID()}` })).deviceId,
      from: companyToday(), days: 1,
    });
    expect(day.tasks.some((t) => t.id === task.id && !t.mine)).toBe(true);

    expect((await send(ray(), [{ kind: "task.claim", subjectId: task.id }])).results[0]!.status).toBe("applied");
    expect((await send(sam(), [{ kind: "task.claim", subjectId: task.id }])).results[0]!.rejection).toBe("Somebody else has that one");
    expect((await send(sam(), [{ kind: "task.close", subjectId: task.id, payload: { outcome: "Done" } }])).results[0]!.status).toBe("rejected");
    expect((await send(ray(), [{ kind: "task.close", subjectId: task.id, payload: { outcome: "Called her" } }])).results[0]!.status).toBe("applied");
    const [row] = await raw`select status, outcome, assignee_user_id from public.task where id = ${task.id}`;
    expect(row).toMatchObject({ status: "done", outcome: "Called her", assignee_user_id: RAY });
  });
});

/* -------------------------------------------------------- the field assistant */

run("the field assistant", () => {
  let visitId = "";

  beforeAll(async () => {
    if (!url) return;
    await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
    const made = await visitFor([rayTech]);
    visitId = made.visitId;
    await raw`update public.visit set technician_notes = 'Anode rod nearly gone. Told her to budget for a new heater.' where id = ${visitId}`;
    await raw`insert into public.equipment (organization_id, property_id, category, manufacturer, model, serial_number, installed_on)
      values (${ORG}, ${propertyId}, 'water_heater', 'Rheem', 'XG50T', 'RH-1', '2014-05-01')`;
    await knowledge.create(owner(), {
      title: "Flushing a tank water heater", tags: ["rheem", "sediment"],
      body: "1. Power off. 2. Close the cold supply. 3. Drain from the valve until it runs clear.",
    });
  });

  it("is off until an owner turns it on", async () => {
    await expect(agentField.ask(ray(), { question: "How do I flush the heater?", visitId }, aiDeps())).rejects.toThrow(/field assistant is off/);
  });

  it("answers from the company's records, as the person asking, and keeps the answer for a retry", async () => {
    await agents.configure(owner(), { agent: "field", settings: { ...coreAgents.defaultSettings("field"), enabled: true } });
    requests.length = 0;
    script = (request) => {
      const text = promptOf(request);
      expect(text).toContain("Flushing a tank water heater");
      expect(text).toContain("Rheem");
      expect(text).toContain("Anode rod nearly gone");
      expect(text).not.toMatch(/900\.0000|cost/i);
      return answer({ answer: "Power off, close the cold supply, and drain from the valve until it runs clear.", sources: ["howto-1"] });
    };
    const ctx = { ...ray(), idempotencyKey: `ask-${crypto.randomUUID()}` };
    const first = await agentField.ask(ctx, { question: "How do we flush a Rheem heater?", visitId }, aiDeps());
    expect(first).toEqual({
      answered: true,
      text: "Power off, close the cold supply, and drain from the valve until it runs clear.",
      sources: [{ kind: "procedure", title: "Flushing a tank water heater" }],
    });
    const again = await agentField.ask(ctx, { question: "How do we flush a Rheem heater?", visitId }, aiDeps());
    expect(again).toEqual(first);
    expect(requests).toHaveLength(1);
    const [usage] = await raw`select agent_id from public.ai_usage where organization_id = ${ORG} order by created_at desc limit 1`;
    expect(usage!.agent_id).toBe("ai:field");
  });

  it("does not show an answer that states a price nobody wrote down", async () => {
    script = () => answer({ answer: "An expansion tank is about $95.", sources: ["price-1"] });
    const reply = await agentField.ask(ray(), { question: "What do we charge for an expansion tank?", visitId }, aiDeps());
    expect(reply.answered).toBe(false);
    expect(reply.text).toMatch(/not in your records/);
    const [refused] = await raw`select detail from public.ai_agent_activity
      where organization_id = ${ORG} and agent = 'field' and kind = 'refused' order by created_at desc limit 1`;
    expect(refused!.detail).toMatch(/not in your records/);
  });

  it("asks no model when nothing in the records matches, and reads no visit off the technician's day", async () => {
    requests.length = 0;
    const reply = await agentField.ask(ray(), { question: "zzqx wobble" }, aiDeps());
    expect(reply).toEqual({ answered: false, text: expect.stringMatching(/^Nothing in your company's records/), sources: [] });
    expect(requests).toHaveLength(0);
    const elsewhere = await visitFor([samTech]);
    await expect(agentField.ask(ray(), { question: "How do I flush it?", visitId: elsewhere.visitId }, aiDeps())).rejects.toThrow(NotFoundError);
  });
});

run("the company's how-to notes", () => {
  it("are written by the office, read by anybody on the work, and taken out of use rather than erased", async () => {
    const note = await knowledge.create(owner(), { title: "Condemning a heat exchanger", body: "Photograph the crack first. Then tag the unit.", tags: ["Furnace", "furnace"] });
    expect(note.tags).toEqual(["furnace"]);
    await expect(knowledge.create(ray(), { title: "Mine", body: "Anything at all", tags: [] })).rejects.toThrow(PermissionError);
    expect((await knowledge.list(ray())).notes.some((n) => n.id === note.id)).toBe(true);
    const changed = await knowledge.update(owner(), { id: note.id, body: "Photograph the crack, then tag the unit red." });
    expect(changed.body).toBe("Photograph the crack, then tag the unit red.");
    expect(await knowledge.remove(owner(), { id: note.id })).toEqual({ id: note.id, removed: true });
    expect((await knowledge.list(ray())).notes.some((n) => n.id === note.id)).toBe(false);
    await expect(knowledge.update(owner(), { id: note.id, title: "Back" })).rejects.toThrow(NotFoundError);
  });
});
