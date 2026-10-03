import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import { dispatch } from "../src/http/dispatch";
import { authenticate } from "../src/http/authenticate";
import { routes } from "../src/contracts/index";
import * as fieldOps from "../src/services/field";
import * as fieldDevices from "../src/services/field-devices";
import * as fieldPayments from "../src/services/field-payments";
import * as dispatchSvc from "../src/services/dispatch";
import * as billing from "../src/services/billing";
import * as tasks from "../src/services/tasks";
import { inTenant, ConflictError, SignInRefusedError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, resetOrg } from "./helpers";

/**
 * THE REST OF THE TECHNICIAN'S PHONE
 *
 * Signing in with a code instead of a password, the office's view of the
 * phones and taking one away, money taken on site, and a technician finishing
 * a task that is theirs. Each against the real services and the real
 * database functions, because the rules that matter (a code is spent once,
 * dies after five guesses, never says whether an address exists; a payment
 * lands in the books dated when it was taken) live in the seams between them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("field-phone:org");
const OWNER = fixtureId("field-phone:owner");
const RAY = fixtureId("field-phone:ray");
const SAM = fixtureId("field-phone:sam");
const RAY_EMAIL = "ray@field-phone.test";
const SAM_EMAIL = "sam@field-phone.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (userId: string, technicianId: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"], technicianId }, db: db(),
});
const ray = () => as(RAY, rayTech);
const sam = () => as(SAM, samTech);

let rayTech = "";
let samTech = "";
let customerId = "";
let propertyId = "";

async function technician(userId: string, email: string, name: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, ${name}) returning id`;
  return tech!.id as string;
}

/** A code sender that writes the message down instead of sending it. */
function capture() {
  const sent: Array<{ channel: string; to: string; body: string; subject: string }> = [];
  const send: fieldDevices.CodeSender = async (_db, input) => {
    sent.push({ channel: input.channel, to: input.to, body: input.body, subject: input.subject });
    return { sent: true, reason: null };
  };
  const code = () => /^(\d{6}) is your/.exec(sent[sent.length - 1]?.body ?? "")?.[1] ?? "";
  return { sent, send, code };
}

async function call(method: string, path: string, body?: unknown) {
  const response = await dispatch(new Request(`https://ops.example.test/api${path}`, {
    method, headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), {
    db: db(), basePath: "/api",
    resolveSession: async (req) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Phone Co", slug: "field-phone" });
  rayTech = await technician(RAY, RAY_EMAIL, "Ray Nunez");
  samTech = await technician(SAM, SAM_EMAIL, "Sam Ortiz");

  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, '+15125559971', 'main', true)`;
  const [c] = await raw`insert into public.customer (organization_id, name, phone)
    values (${ORG}, 'Nina Patel', '+15125550141') returning id`;
  customerId = c!.id;
  await raw`insert into public.communication_consent
    (organization_id, address, channel, purpose, state, method, captured_at)
    values (${ORG}, '+15125550141', 'sms', 'transactional', 'granted', 'verbal', now())`;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Elm St', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${RAY}, ${SAM})`;
  await raw.end();
});

/* ------------------------------------------------------------- codes */

run("signing in with a code", () => {
  beforeEach(async () => {
    await raw`delete from public.sign_in_code where user_id in (${RAY}, ${SAM}, ${OWNER})`;
    await fieldDevices.setMobile(owner(), { id: rayTech, mobilePhone: "(512) 555-0199" });
  });

  it("texts a code to the number the office recorded, and the code signs the phone in once", async () => {
    const { sent, send, code } = capture();
    const answer = await fieldDevices.requestCode(db(), { email: RAY_EMAIL, channel: "sms" }, undefined, { send });
    expect(answer.message).toMatch(/^If that email belongs to a technician with a mobile number on file/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "sms", to: "+15125550199" });
    expect(sent[0]!.body).toMatch(/^\d{6} is your Phone Co sign in code/);

    const signed = await fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: code() });
    expect(signed.token.startsWith("otd_")).toBe(true);
    expect(signed.user.email).toBe(RAY_EMAIL);

    await expect(fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: code() }))
      .rejects.toThrow("That code is not right, or it has expired. Ask for a new one.");
  });

  it("emails the code to the person's own address when asked to", async () => {
    const { sent, send, code } = capture();
    await fieldDevices.requestCode(db(), { email: SAM_EMAIL, channel: "email" }, undefined, { send });
    expect(sent[0]).toMatchObject({ channel: "email", to: SAM_EMAIL, subject: "Your Phone Co sign in code" });
    await expect(fieldDevices.signInWithCodeFor(db(), { email: SAM_EMAIL, code: ` ${code().slice(0, 3)} ${code().slice(3)} ` }))
      .resolves.toMatchObject({ user: { email: SAM_EMAIL } });
  });

  it("keeps only a hash, and nothing in the company can read it", async () => {
    const { send, code } = capture();
    await fieldDevices.requestCode(db(), { email: RAY_EMAIL, channel: "sms" }, undefined, { send });
    const [row] = await raw`select code_hash from public.sign_in_code where user_id = ${RAY} and used_at is null`;
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.code_hash).not.toContain(code());
    const seen = await inTenant(owner(), async (tx) => tx.execute(`select * from public.sign_in_code` as never));
    expect(seen).toHaveLength(0);
    const inbox = await raw`select count(*)::int as n from public.message where organization_id = ${ORG} and body like ${`%${code()}%`}`;
    expect(inbox[0]!.n).toBe(0);
  });

  it("answers the same sentence for an unknown address, an owner and a technician with no number, and sends nothing", async () => {
    const { sent, send } = capture();
    const unknown = await fieldDevices.requestCode(db(), { email: "nobody@field-phone.test", channel: "sms" }, undefined, { send });
    const office = await fieldDevices.requestCode(db(), { email: "field-phone@test.local", channel: "sms" }, undefined, { send });
    await fieldDevices.setMobile(owner(), { id: samTech, mobilePhone: null });
    const noNumber = await fieldDevices.requestCode(db(), { email: SAM_EMAIL, channel: "sms" }, undefined, { send });
    expect(new Set([unknown.message, office.message, noNumber.message]).size).toBe(1);
    expect(sent).toHaveLength(0);
    const [audit] = await raw`select after from public.audit_log
      where organization_id = ${ORG} and action = 'device.code_not_sent' order by created_at desc limit 1`;
    expect((audit!.after as { reason: string }).reason).toBe("No mobile number is recorded for this technician.");
  });

  it("dies after five wrong guesses, even for the right code after them", async () => {
    const { send, code } = capture();
    await fieldDevices.requestCode(db(), { email: RAY_EMAIL, channel: "sms" }, undefined, { send });
    const right = code();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: wrong })).rejects.toThrow(SignInRefusedError);
    }
    await expect(fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: right })).rejects.toThrow(SignInRefusedError);
  });

  it("refuses a typo without counting it, and an expired code like any other", async () => {
    await expect(fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: "12345" }))
      .rejects.toThrow("Enter the 6 digit code from the text or email.");
    const { send, code } = capture();
    await fieldDevices.requestCode(db(), { email: RAY_EMAIL, channel: "sms" }, undefined, { send });
    await raw`update public.sign_in_code set expires_at = now() - interval '1 minute' where user_id = ${RAY}`;
    await expect(fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: code() }))
      .rejects.toThrow("That code is not right, or it has expired. Ask for a new one.");
  });

  it("sends three codes in fifteen minutes and no fourth, and only the newest works", async () => {
    const { sent, send } = capture();
    for (let i = 0; i < 4; i++) {
      await fieldDevices.requestCode(db(), { email: RAY_EMAIL, channel: "sms" }, undefined, { send });
    }
    expect(sent).toHaveLength(3);
    const first = /^(\d{6})/.exec(sent[0]!.body)![1]!;
    const last = /^(\d{6})/.exec(sent[2]!.body)![1]!;
    if (first !== last) {
      await expect(fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: first })).rejects.toThrow(SignInRefusedError);
    }
    await expect(fieldDevices.signInWithCodeFor(db(), { email: RAY_EMAIL, code: last })).resolves.toMatchObject({});
    const [refused] = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'device.code_refused'`;
    expect(refused!.n).toBeGreaterThanOrEqual(1);
  });

  it("is a public route that answers 201 for asking and 401 for a wrong code, in words", async () => {
    await raw`delete from public.sign_in_code where user_id = ${SAM}`;
    const asked = await call("POST", "/v1/field/sign-in/code", { email: "nobody-else@field-phone.test", channel: "email" });
    expect(asked.status).toBe(201);
    expect(routes.requestSignInCode.output.parse(asked.body).message).toMatch(/^If that email belongs/);
    const tried = await call("POST", "/v1/field/sign-in/verify", { email: SAM_EMAIL, code: "123456" });
    expect(tried.status).toBe(401);
    expect(tried.body["error"]).toBe("That code is not right, or it has expired. Ask for a new one.");
  });
});

/* ------------------------------------------------------------ phones */

run("the office's view of the phones", () => {
  it("lists each technician with their phones, and takes one away, ending its notices too", async () => {
    const registered = await fieldOps.register(ray(), {
      installationId: `ray-${crypto.randomUUID()}`, label: "iPhone app", platform: "ios",
      pushToken: "ExponentPushToken[rayphonerayphone00]",
    });
    await raw`update public.device set session_token_hash = 'x'::text where id = ${registered.deviceId}`;

    let people = await fieldDevices.people(owner(), {});
    const rayRow = people.technicians.find((t) => t.id === rayTech)!;
    const phone = rayRow.devices.find((d) => d.id === registered.deviceId)!;
    expect(phone).toMatchObject({ label: "iPhone app", signedIn: true, notifications: true, revokedAt: null });

    await fieldDevices.revoke(owner(), { id: registered.deviceId });
    people = await fieldDevices.people(owner(), {});
    const after = people.technicians.find((t) => t.id === rayTech)!.devices.find((d) => d.id === registered.deviceId)!;
    expect(after).toMatchObject({ signedIn: false, notifications: false });
    expect(after.revokedAt).not.toBeNull();
  });

  it("keeps the code number in a form a carrier takes, and refuses one that is not a number", async () => {
    await expect(fieldDevices.setMobile(owner(), { id: samTech, mobilePhone: "512 555 0100" }))
      .resolves.toEqual({ id: samTech, mobilePhone: "+15125550100" });
    await expect(fieldDevices.setMobile(owner(), { id: samTech, mobilePhone: "call the shop" }))
      .rejects.toThrow(ConflictError);
  });

  it("is the office's: a technician can neither list the phones nor set a number", async () => {
    await expect(fieldDevices.people(ray(), {})).rejects.toThrow(PermissionError);
    await expect(fieldDevices.setMobile(ray(), { id: rayTech, mobilePhone: "5125550100" })).rejects.toThrow(PermissionError);
  });
});

/* ------------------------------------------------------------ money */

async function visitWithInvoice(total: string | null, technicianId = rayTech) {
  const [job] = await raw`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId}, 'scheduled', 'Water heater')
    returning id`;
  const [visit] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'working', now(), now() + interval '2 hours') returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
    values (${ORG}, ${visit!.id}, ${technicianId})`;
  let invoiceId: string | null = null;
  if (total) {
    const invoice = await billing.create(owner(), {
      customerId, jobId: job!.id,
      lines: [{ name: "Water heater", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
    } as never);
    invoiceId = invoice.id as string;
  }
  return { jobId: job!.id as string, visitId: visit!.id as string, invoiceId };
}

async function collect(visitId: string, payload: Record<string, unknown>) {
  const device = await fieldOps.register(ray(), { installationId: `ray-${crypto.randomUUID()}` });
  const result = await fieldOps.sync(ray(), {
    deviceId: device.deviceId,
    operations: [{
      clientId: crypto.randomUUID(), sequence: 1, kind: "payment.collect", subjectId: visitId,
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(), payload,
    }],
  });
  return result.results[0]!;
}

run("money taken on site", () => {
  it("records cash against this job's invoice, dated when it was handed over", async () => {
    const { visitId, invoiceId } = await visitWithInvoice("180.00");
    const result = await collect(visitId, { method: "cash", amount: "100.00", note: "In an envelope" });
    expect(result).toMatchObject({ status: "applied", rejection: null });

    const [payment] = await raw`select p.method, p.amount::text, p.received_at, p.notes, a.amount::text as applied
      from public.payment p join public.payment_allocation a on a.payment_id = p.id
      where p.organization_id = ${ORG} and a.invoice_id = ${invoiceId}`;
    expect(payment).toMatchObject({ method: "cash", amount: "100.0000", applied: "100.0000" });
    expect(payment!.notes).toMatch(/^Taken on site, job \d+\. In an envelope$/);
    expect(Math.abs(new Date(payment!.received_at).getTime() - (Date.now() - 3_600_000))).toBeLessThan(60_000);

    const [invoice] = await raw`select balance::text, status from public.invoice where id = ${invoiceId}`;
    expect(invoice).toMatchObject({ balance: "80.0000", status: "partially_paid" });
  });

  it("holds cash for the customer when nothing has been invoiced yet", async () => {
    const { visitId } = await visitWithInvoice(null);
    expect(await collect(visitId, { method: "cash", amount: "40" })).toMatchObject({ status: "applied" });
    const rows = await raw`select p.id from public.payment p
      left join public.payment_allocation a on a.payment_id = p.id
      where p.organization_id = ${ORG} and p.amount = 40 and a.id is null`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses a check with no number, an amount that is not money, and a card, each in words", async () => {
    const { visitId } = await visitWithInvoice("50.00");
    expect(await collect(visitId, { method: "check", amount: "50.00" })).toMatchObject({
      status: "rejected", rejection: "A check needs its number, so the office can match it to the bank.",
    });
    expect(await collect(visitId, { method: "cash", amount: "fifty" })).toMatchObject({
      status: "rejected", rejection: "fifty is not an amount of money.",
    });
    expect((await collect(visitId, { method: "card", amount: "50.00" })).rejection).toMatch(/payment link/);
    expect(await collect(visitId, { method: "check", amount: "50.00", checkNumber: "1042" })).toMatchObject({ status: "applied" });
  });

  it("shows what is still owed on the phone's day", async () => {
    const { visitId } = await visitWithInvoice("75.00");
    const device = await fieldOps.register(ray(), { installationId: `ray-${crypto.randomUUID()}` });
    const today = new Date().toISOString().slice(0, 10);
    const day = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: today, days: 2 });
    const visit = day.visits.find((v) => v.id === visitId);
    expect(visit?.amountDue).toBe("75.0000");
    expect(visit?.report).toEqual({ id: null, submitted: false, fields: [] });
  });

  it("refuses a card link with no card payments connected, then gives one and texts it", async () => {
    const { visitId, invoiceId } = await visitWithInvoice("120.00");
    await expect(fieldPayments.paymentLink(ray(), { id: visitId, text: true }))
      .rejects.toThrow("This company has not connected card payments, so a link cannot take a card. Take cash or a check.");

    await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
      values (${ORG}, 'payments', 'stripe', 'connected', 'STRIPE_TEST_KEY', '{}'::jsonb)`;
    const link = await fieldPayments.paymentLink(ray(), { id: visitId, text: true });
    expect(link).toMatchObject({ invoiceId, amountDue: "120.0000", texted: true, reason: null });
    expect(link.url).toMatch(/^https?:\/\//);

    const [text] = await raw`select body from public.message
      where organization_id = ${ORG} and to_address = '+15125550141' order by created_at desc limit 1`;
    expect(text!.body).toContain(link.url);
    expect(text!.body).toContain("$120.00");
  });

  it("gives a link only to the technician on the visit, or somebody who may send invoices", async () => {
    const { visitId } = await visitWithInvoice("60.00", rayTech);
    await expect(fieldPayments.paymentLink(sam(), { id: visitId, text: false })).rejects.toThrow(PermissionError);
    await expect(fieldPayments.paymentLink(owner(), { id: visitId, text: false })).resolves.toMatchObject({ texted: false });
  });

  it("says there is nothing to pay when the job has no open invoice", async () => {
    const { visitId } = await visitWithInvoice(null);
    await expect(fieldPayments.paymentLink(ray(), { id: visitId, text: false }))
      .rejects.toThrow(/^There is no invoice with money owing on this job yet/);
  });
});

/* ------------------------------------------------------------ tasks */

run("a technician finishing their own task", () => {
  it("lets the person a task is assigned to mark it done with only task:read", async () => {
    const task = await tasks.create(owner(), { title: "Return the ladder to the shop", assigneeUserId: RAY });
    const closed = await tasks.close(ray(), { id: task.id, outcome: "Back on the rack" });
    expect(closed).toMatchObject({ status: "done", completedByUserId: RAY });
  });

  it("does not let them dismiss it, or close somebody else's", async () => {
    const mine = await tasks.create(owner(), { title: "Check the van", assigneeUserId: RAY });
    await expect(tasks.close(ray(), { id: mine.id, outcome: "Not needed", dismissed: true })).rejects.toThrow(PermissionError);
    const theirs = await tasks.create(owner(), { title: "Ring the supplier", assigneeUserId: SAM });
    await expect(tasks.close(ray(), { id: theirs.id, outcome: "Done" })).rejects.toThrow(PermissionError);
    const nobodys = await tasks.create(owner(), { title: "Sweep the yard" });
    await expect(tasks.close(ray(), { id: nobodys.id })).rejects.toThrow(PermissionError);
  });
});
