import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import type { EmailProvider, OutboundEmail } from "../src/email/provider";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as company from "../src/services/company";
import * as branches from "../src/services/branches";
import * as team from "../src/services/team";
import * as email from "../src/services/email";
import * as setupTokens from "../src/services/setup-tokens";
import * as peopleRecords from "../src/services/people-records";
import * as staffDocuments from "../src/services/staff-documents";
import * as me from "../src/services/me";
import * as payroll from "../src/services/payroll";
import * as commissions from "../src/services/commissions";
import * as laborSettings from "../src/services/labor-settings";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A PERSON'S OWN RECORD, AN INVITE BY EMAIL, AND A BRANCH'S MARK ON A NUMBER
 *
 * The self service half of M24 and M17 is one promise: somebody signs in and
 * sees and keeps THEIR record, and nobody else's. So most of this file is the
 * other half of each assertion: Ray reads his record, and Ray cannot read,
 * change, tick, sign or be paid from Sam's, by any id he could send.
 *
 * The invite tests are about the one property that makes emailing a sign in
 * link safe: the link is in the copy the provider receives and nowhere in the
 * database a colleague could read.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("self-service:org");
const OWNER = fixtureId("self-service:owner");
const RAY = fixtureId("self-service:ray");
const SAM = fixtureId("self-service:sam");
const ODA = fixtureId("self-service:oda");
const FROM = "office@selfservice.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] }, db: db() });
const as = (userId: string, roles: Actor["roles"], technicianId?: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles, ...(technicianId ? { technicianId } : {}) }, db: db(),
});

let rayMembership = "";
let samMembership = "";
let rayTech = "";
let samTech = "";
let customerId = "";
let propertyId = "";

const ray = () => as(RAY, ["technician"], rayTech);
const sam = () => as(SAM, ["technician"], samTech);

function fakeProvider(): EmailProvider & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    name: "fake",
    sent,
    delivery: { kind: "none", because: "A fake reports nothing." },
    async send(message) {
      sent.push(message);
      return { ok: true, providerMessageId: `fake_${sent.length}` };
    },
  };
}

async function person(userId: string, emailAddress: string, name: string, role: string): Promise<string> {
  await raw`delete from public."user" where id = ${userId} or email = ${emailAddress}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${emailAddress}, ${name})`;
  await raw`insert into public.credential (user_id, password_hash) values (${userId}, 'not-a-real-hash')`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}::public.member_role) returning id`;
  return row!.id;
}

const tokenIn = (text: string | undefined) => /\/welcome\?token=([A-Za-z0-9_%-]+)/.exec(text ?? "")?.[1];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Self Service Heating", slug: "self-service-heating" });
  /**
   * The people this file invites are accounts, which are not the company's
   * and outlive its reset; a second run would find each address taken.
   */
  await raw`delete from public."user" where email like ${"self-service-%@test.local"} and id <> ${OWNER}`;
  await raw`update public."user" set name = 'Olive Owner' where id = ${OWNER}`;

  rayMembership = await person(RAY, "self-service-ray@test.local", "Ray Ortiz", "technician");
  samMembership = await person(SAM, "self-service-sam@test.local", "Sam Pike", "technician");
  await person(ODA, "self-service-oda@test.local", "Oda Office", "office_manager");
  const [r] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${rayMembership}, 'Ray Ortiz') returning id`;
  const [s] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${samMembership}, 'Sam Pike') returning id`;
  rayTech = r!.id;
  samTech = s!.id;

  const created = await customers.create(owner(), {
    type: "residential", name: "Delacroix", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = created.id as string;
  propertyId = (await properties.create(owner(), {
    address: { line1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id as string;
});

afterAll(async () => { if (raw) await raw.end(); });

/* ================================================================ invites */

run("an invite is emailed, and the link is in the email and nowhere else", () => {
  const previous = process.env["PUBLIC_URL"];
  beforeAll(async () => {
    process.env["PUBLIC_URL"] = "https://ots.selfservice.test";
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
      values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: FROM })})`;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env["PUBLIC_URL"]; else process.env["PUBLIC_URL"] = previous;
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
  });

  it("queues the email with the link left out, and the outbox puts a working one in as it sends", async () => {
    const sent = await team.invite(owner(), { email: "self-service-new@test.local", name: "Nia New", role: "technician" });
    expect(sent.emailed).toBe(true);
    expect(sent.emailNote).toBeNull();
    expect(sent.link).toMatch(/^https:\/\/ots\.selfservice\.test\/welcome\?token=/);
    expect(new Date(sent.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    const [queued] = await raw<{ id: string; body: string; body_html: string; status: string; sealed_invite_id: string | null; to_address: string }[]>`
      select id, body, body_html, status, sealed_invite_id, to_address from public.message
      where organization_id = ${ORG} and to_address = 'self-service-new@test.local'`;
    expect(queued!.status).toBe("queued");
    expect(queued!.sealed_invite_id).not.toBeNull();
    // Nobody who reads the inbox reads a link: the stored email says where it goes.
    expect(queued!.body).not.toContain("token=");
    expect(queued!.body_html).not.toContain("token=");
    expect(queued!.body).toContain("Olive Owner has added you to Self Service Heating's team");

    const provider = fakeProvider();
    const outcomes = await email.flush(db(), ORG, { provider });
    expect(outcomes.find((o) => o.messageId === queued!.id)?.status).toBe("sent");
    const delivered = provider.sent.find((m) => m.to === "self-service-new@test.local")!;
    const emailedToken = tokenIn(delivered.text);
    expect(emailedToken).toBeDefined();
    expect(delivered.html).toContain(`token=${emailedToken}`);

    // Both links open the same account, the inviter's and the emailed one.
    expect((await setupTokens.peek(db(), decodeURIComponent(emailedToken!)))?.email).toBe("self-service-new@test.local");
    expect((await setupTokens.peek(db(), decodeURIComponent(tokenIn(sent.link!)!)))?.email).toBe("self-service-new@test.local");

    // And after sending, the stored copy still carries no link.
    const [after] = await raw<{ body: string; status: string }[]>`select body, status from public.message where id = ${queued!.id}`;
    expect(after!.status).toBe("sent");
    expect(after!.body).not.toContain("token=");

    const roster = await team.roster(owner());
    const nia = roster.find((p) => p.email === "self-service-new@test.local")!;
    expect(nia.waiting).toBe(true);
    expect(nia.invite?.email).toBe("sent");
    expect(nia.invite?.sentence).toMatch(/^Emailed\. The link works until /);
  });

  it("sends a new invite on resend, and every link of the old one stops working", async () => {
    const first = await team.invite(owner(), { email: "self-service-again@test.local", name: "Abe Again", role: "csr" });
    const provider = fakeProvider();
    await email.flush(db(), ORG, { provider });
    const firstEmailed = tokenIn(provider.sent.find((m) => m.to === "self-service-again@test.local")!.text)!;

    const second = await team.resendInvite(owner(), { membershipId: first.membershipId });
    expect(second.reissued).toBe(true);
    expect(second.emailed).toBe(true);
    expect(await setupTokens.peek(db(), decodeURIComponent(tokenIn(first.link!)!))).toBeNull();
    expect(await setupTokens.peek(db(), decodeURIComponent(firstEmailed))).toBeNull();
    expect(await setupTokens.peek(db(), decodeURIComponent(tokenIn(second.link!)!))).not.toBeNull();

    const invites = await raw<{ replaced_at: Date | null }[]>`
      select replaced_at from public.membership_invite where membership_id = ${first.membershipId} order by created_at`;
    expect(invites.map((i) => i.replaced_at !== null)).toEqual([true, false]);

    // The first invite's email, had it still been waiting, would now go nowhere.
    const later = fakeProvider();
    await email.flush(db(), ORG, { provider: later });
    expect(tokenIn(later.sent.find((m) => m.to === "self-service-again@test.local")?.text)).toBeDefined();
  });

  it("does not send an invite that ran out while it waited, and says so", async () => {
    const sent = await team.invite(owner(), { email: "self-service-late@test.local", name: "Lee Late", role: "csr" });
    await raw`update public.membership_invite set expires_at = now() - interval '1 minute'
      where membership_id = ${sent.membershipId}`;
    const provider = fakeProvider();
    await email.flush(db(), ORG, { provider });
    expect(provider.sent.find((m) => m.to === "self-service-late@test.local")).toBeUndefined();
    const [row] = await raw<{ status: string; error_code: string }[]>`
      select status, error_code from public.message where organization_id = ${ORG} and to_address = 'self-service-late@test.local'`;
    expect(row).toMatchObject({ status: "failed", error_code: "invite_unavailable" });

    const lee = (await team.roster(owner())).find((p) => p.email === "self-service-late@test.local")!;
    expect(lee.invite?.expired).toBe(true);
    expect(lee.invite?.sentence).toMatch(/^The invite ran out on .*Send a new one\.$/);
  });

  it("is still made, with the link to send by hand, when no email provider is connected", async () => {
    await raw`delete from public.integration_connection where organization_id = ${ORG}`;
    const sent = await team.invite(owner(), { email: "self-service-nomail@test.local", name: "Noa Nomail", role: "csr" });
    expect(sent.emailed).toBe(false);
    expect(sent.emailNote).toBe("no email provider is connected");
    expect(sent.link).not.toBeNull();
    const noa = (await team.roster(owner())).find((p) => p.email === "self-service-nomail@test.local")!;
    expect(noa.invite?.sentence).toMatch(/^Not emailed \(no email provider is connected\), so send them the link yourself\./);
  });
});

/* ======================================================= one's own record */

run("a person sees their own record and nobody else's", () => {
  beforeAll(async () => {
    await peopleRecords.setEmployment(owner(), {
      membershipId: rayMembership, startedOn: "2025-03-01", employmentType: "full_time", payType: "hourly",
      jobTitle: "Service technician",
    });
    await peopleRecords.addEmergencyContact(owner(), { membershipId: samMembership, name: "Sam's mother", phone: "512 555 0100" });
  });

  it("reads their own employment, and not the roster or anybody else's record", async () => {
    const record = await me.record(ray());
    expect(record.membershipId).toBe(rayMembership);
    expect(record.name).toBe("Ray Ortiz");
    expect(record.employment?.jobTitle).toBe("Service technician");
    expect(record.technicianId).toBe(rayTech);
    await expect(peopleRecords.person(ray(), { membershipId: samMembership })).rejects.toBeInstanceOf(PermissionError);
    await expect(peopleRecords.roster(ray())).rejects.toBeInstanceOf(PermissionError);
  });

  it("keeps their own emergency contacts, and cannot touch anybody else's", async () => {
    const contacts = await me.addContact(ray(), { name: "Rosa Ortiz", relationship: "Wife", phone: "512 555 0199" });
    expect(contacts.map((c) => c.name)).toEqual(["Rosa Ortiz"]);
    const [samsContact] = await raw<{ id: string }[]>`
      select id from public.emergency_contact where membership_id = ${samMembership}`;
    await expect(me.removeContact(ray(), { id: samsContact!.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await me.removeContact(ray(), { id: contacts[0]!.id }))).toEqual([]);
    // Removing it again is the same answer, not an error.
    expect((await me.removeContact(ray(), { id: contacts[0]!.id }))).toEqual([]);
    const [still] = await raw<{ deleted_at: Date | null }[]>`
      select deleted_at from public.emergency_contact where id = ${samsContact!.id}`;
    expect(still!.deleted_at).toBeNull();
  });

  it("is refused to somebody with no membership here, such as the system", async () => {
    await expect(me.record(as("00000000-0000-0000-0000-000000000000", [], undefined)))
      .rejects.toBeInstanceOf(PermissionError);
    const stranger: ServiceContext = {
      actor: { userId: fixtureId("self-service:nobody"), organizationId: ORG, roles: ["technician"] }, db: db(),
    };
    await expect(me.record(stranger)).rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ================================================ onboarding and signing */

run("a person ticks their own onboarding and signs what they were given", () => {
  let handbook = "";
  let vehicle = "";

  beforeAll(async () => {
    handbook = (await staffDocuments.create(owner(), {
      title: "Employee handbook",
      body: "Show up on time, wear your boots, and call the office before you leave a job unfinished.",
    })).id;
    vehicle = (await staffDocuments.create(owner(), {
      title: "Vehicle use agreement",
      body: "The van is for work. No passengers who do not work here. Report every scratch the same day.",
    })).id;
    await peopleRecords.addTemplateItem(owner(), { role: "technician", kind: "document", label: "Handbook signed", staffDocumentId: handbook });
    await peopleRecords.addTemplateItem(owner(), { role: "technician", kind: "training", label: "Ladder safety" });
    await peopleRecords.startOnboarding(owner(), { membershipId: rayMembership });
    await peopleRecords.startOnboarding(owner(), { membershipId: samMembership });
  });

  it("refuses a document line that is not a document, and a retired document", async () => {
    await expect(peopleRecords.addTemplateItem(owner(), {
      role: "technician", kind: "training", label: "Read the handbook", staffDocumentId: handbook,
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("hands the checklist's documents to them when onboarding starts", async () => {
    const record = await me.record(ray());
    expect(record.documents.map((d) => d.title)).toEqual(["Employee handbook"]);
    expect(record.documents[0]!.signedAt).toBeNull();
    expect(record.documents[0]!.body).toContain("wear your boots");
  });

  it("ticks their own line, unticks what they ticked, and cannot untick the office's or touch Sam's", async () => {
    const ladder = (await me.record(ray())).onboarding.lines.find((l) => l.label === "Ladder safety")!;
    const ticked = await me.setOnboardingLine(ray(), { id: ladder.id, done: true, note: "Did the course Monday" });
    expect(ticked.lines.find((l) => l.id === ladder.id)).toMatchObject({ doneBy: "Ray Ortiz", note: "Did the course Monday" });
    await me.setOnboardingLine(ray(), { id: ladder.id, done: false });

    await peopleRecords.setOnboardingLine(owner(), { id: ladder.id, done: true, note: "Seen it done" });
    await expect(me.setOnboardingLine(ray(), { id: ladder.id, done: false })).rejects.toThrow(/The office ticked this one/);

    const samsLine = (await peopleRecords.person(owner(), { membershipId: samMembership })).onboarding.lines[0]!;
    await expect(me.setOnboardingLine(ray(), { id: samsLine.id, done: true })).rejects.toBeInstanceOf(NotFoundError);

    const handbookLine = (await me.record(ray())).onboarding.lines.find((l) => l.staffDocumentId === handbook)!;
    await expect(me.setOnboardingLine(ray(), { id: handbookLine.id, done: true })).rejects.toThrow(/signing the document/);
  });

  it("signs by typing their name, which ticks the line and keeps the record every signature keeps", async () => {
    const request = (await me.record(ray())).documents[0]!;
    await expect(me.sign(ray(), { requestId: request.requestId })).rejects.toThrow(/Type your full name, or draw/);
    await expect(me.sign(ray(), { requestId: request.requestId, typedName: "Ray", drawing: "data:image/png;base64,iVBORw0KGgo=" }))
      .rejects.toThrow(/not both/);

    const signed = await me.sign(ray(), { requestId: request.requestId, typedName: "Ray Ortiz", ipAddress: "203.0.113.9" });
    expect(signed).toMatchObject({ signedVia: "typed", signerName: "Ray Ortiz" });
    // Signing again is the first signature, not a second.
    const again = await me.sign(ray(), { requestId: request.requestId, typedName: "Somebody Else" });
    expect(again.signedAt).toBe(signed.signedAt);

    const [doc] = await raw<{ body_hash: string }[]>`select body_hash from public.staff_document where id = ${handbook}`;
    const signatures = await raw<{ subject: string; signer_name: string; signer_email: string; document_hash: string; ip_address: string }[]>`
      select subject, signer_name, signer_email, document_hash, ip_address from public.document_signature
      where organization_id = ${ORG} and subject_id = ${request.requestId}`;
    expect(signatures).toEqual([{
      subject: "staff_document", signer_name: "Ray Ortiz", signer_email: "self-service-ray@test.local",
      document_hash: doc!.body_hash, ip_address: "203.0.113.9",
    }]);

    const record = await me.record(ray());
    expect(record.onboarding.lines.find((l) => l.staffDocumentId === handbook)?.doneAt).not.toBeNull();
    expect(record.onboarding.progress.complete).toBe(true);

    const listed = (await staffDocuments.list(owner())).find((d) => d.id === handbook)!;
    expect(listed).toMatchObject({ asked: 2, signed: 1 });
    const officeView = await staffDocuments.get(owner(), { id: handbook });
    expect(officeView.requests.find((r) => r.membershipId === rayMembership)).toMatchObject({ signedVia: "typed", signerName: "Ray Ortiz" });
  });

  it("cannot sign Sam's document, which is not there for Ray", async () => {
    const samsRequest = (await me.record(sam())).documents[0]!;
    await expect(me.sign(ray(), { requestId: samsRequest.requestId, typedName: "Ray Ortiz" })).rejects.toBeInstanceOf(NotFoundError);
    const [row] = await raw<{ signed_at: Date | null }[]>`select signed_at from public.staff_document_request where id = ${samsRequest.requestId}`;
    expect(row!.signed_at).toBeNull();
  });

  it("signs by drawing, kept as a picture beside the signature, and the office can ask again once only", async () => {
    await staffDocuments.ask(owner(), { id: vehicle, membershipIds: [samMembership, samMembership] });
    const view = await staffDocuments.ask(owner(), { id: vehicle, membershipIds: [samMembership] });
    expect(view.requests).toHaveLength(1);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64",
    ).toString("base64");
    const request = (await me.record(sam())).documents.find((d) => d.documentId === vehicle)!;
    const signed = await me.sign(sam(), { requestId: request.requestId, drawing: `data:image/png;base64,${png}` });
    expect(signed).toMatchObject({ signedVia: "drawn", signerName: "Sam Pike" });
    const [picture] = await raw<{ kind: string }[]>`
      select a.kind from public.attachment a
      join public.document_signature s on s.id = a.entity_id
      where a.entity_type = 'document_signature' and s.subject_id = ${request.requestId}`;
    expect(picture!.kind).toBe("signature");
  });

  it("asks nobody new to sign a retired document", async () => {
    await staffDocuments.retire(owner(), { id: vehicle });
    await expect(staffDocuments.ask(owner(), { id: vehicle, membershipIds: [rayMembership] })).rejects.toThrow(/retired/);
  });
});

/* =============================================================== own pay */

run("a person sees their own pay for closed periods, and nobody else's", () => {
  /** Monday the 2nd of February 2026, a fortnight, long finished. */
  const START = "2026-02-02";
  const at = (day: number, hour: number) => new Date(Date.UTC(2026, 1, day, hour + 6));

  beforeAll(async () => {
    await laborSettings.setScale(owner(), {
      classification: "Journeyman", baseRate: "30.00", fringeRate: "0.00", effectiveFrom: "2026-01-01",
    });
    await laborSettings.setPolicy(owner(), {
      label: "Federal", timeZone: "America/Chicago", weekStartsOn: 1,
      dayAttribution: "shift_start", weeklyThresholdMinutes: 2400,
      overtimeMultiplier: "1.5", doubleTimeMultiplier: "2",
      onCallTreatment: "separate_rate_not_hours_worked",
      note: "Forty hours a week.",
    });
    const shift = async (technicianId: string, day: number, rate: string) => raw`
      insert into public.timeclock_entry (organization_id, technician_id, started_at, ended_at, minutes, classification, applied_base_rate, applied_loaded_rate)
      values (${ORG}, ${technicianId}, ${at(day, 8)}, ${at(day, 16)}, 480, 'Journeyman', ${rate}, ${rate})`;
    await shift(rayTech, 3, "30.0000");
    await shift(rayTech, 4, "30.0000");
    await shift(samTech, 3, "35.0000");
    /** And one in the fortnight after, which nobody has closed. */
    await shift(rayTech, 17, "30.0000");

    const plan = await commissions.declarePlan(owner(), {
      label: "Tenth of revenue", basis: "percent_of_revenue", rate: "0.10", note: "A tenth of what the job invoiced.",
    });
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "Install", tags: [], customFields: {} });
    const invoice = await billing.create(owner(), {
      customerId, jobId: job.id as string,
      lines: [{ name: "Install", quantity: "1", unitPrice: "1000.00", discountAmount: "0", taxable: false }],
    });
    await commissions.settle(owner(), {
      invoiceId: invoice.id as string, planId: plan.id, shares: [{ technicianId: rayTech, weight: "1" }],
      occurredAt: at(5, 12),
    });

    const closed = await payroll.declarePeriod(owner(), { label: "Fortnight to 15 February", startDate: START, weeks: 2 });
    await payroll.closePeriod(owner(), { periodId: closed.id });
    await payroll.declarePeriod(owner(), { label: "Fortnight to 1 March", startDate: "2026-02-16", weeks: 2 });
  });

  it("is Ray's lines for the closed fortnight, as the register has them, with the commission behind them", async () => {
    const own = await payroll.ownStatements(ray());
    expect(own.technician).toBe(true);
    expect(own.statements.map((s) => s.label)).toEqual(["Fortnight to 15 February"]);
    const fortnight = own.statements[0]!;
    expect(fortnight.statement?.gross).toBe("580.0000");
    expect(fortnight.statement?.lines.find((l) => l.kind === "regular")).toMatchObject({ hours: "16.00", rate: "30.0000" });
    expect(fortnight.commissions).toHaveLength(1);
    expect(fortnight.commissions[0]).toMatchObject({ kind: "earned", amount: "100.0000", paidAt: null });

    const register = await payroll.register(owner(), { periodId: fortnight.periodId });
    const raysRow = register.rows.find((row) => row.technicianId === rayTech)!;
    expect(fortnight.statement?.lines).toEqual(raysRow.lines);
  });

  it("is Sam's alone for Sam, and nothing of Ray's", async () => {
    const own = await payroll.ownStatements(sam());
    expect(own.statements[0]!.statement?.gross).toBe("280.0000");
    expect(own.statements[0]!.commissions).toEqual([]);
  });

  it("is nothing to somebody with no place on the board, and the register stays payroll's", async () => {
    expect(await payroll.ownStatements(as(ODA, ["office_manager"]))).toEqual({ technician: false, statements: [] });
    await expect(payroll.register(ray(), { periodId: (await payroll.ownStatements(ray())).statements[0]!.periodId }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

/* ============================================= a branch's mark on numbers */

run("a branch's code in front of new job and invoice numbers, when the company says so", () => {
  let austin = "";
  let before = "";

  beforeAll(async () => {
    austin = (await company.createBusinessUnit(owner(), { name: "Austin", code: "aus" })).id;
    await company.createBusinessUnit(owner(), { name: "Round Rock", code: "Round Rock" });
    before = (await jobs.create(owner(), {
      customerId, propertyId, summary: "Before the setting", tags: [], customFields: {}, businessUnitId: austin,
    })).id as string;
  });

  it("marks nothing until it is turned on, and says which branches' codes cannot be a mark", async () => {
    const setting = await branches.numbering(owner());
    expect(setting).toEqual({ jobs: false, invoices: false, unusableCodes: ["Round Rock"] });
    const [row] = await raw<{ number_prefix: string | null }[]>`select number_prefix from public.job where id = ${before}`;
    expect(row!.number_prefix).toBeNull();
  });

  it("marks new jobs and invoices in a branch, leaves numbers already given alone, and stops when turned off", async () => {
    await branches.setNumbering(owner(), { jobs: true, invoices: true });
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "After the setting", tags: [], customFields: {}, businessUnitId: austin,
    });
    expect((job as { numberPrefix?: string | null }).numberPrefix).toBe("AUS");
    const nowhere = await jobs.create(owner(), { customerId, propertyId, summary: "No branch", tags: [], customFields: {} });
    expect((nowhere as { numberPrefix?: string | null }).numberPrefix).toBeNull();

    const invoice = await billing.create(owner(), {
      customerId, jobId: job.id as string,
      lines: [{ name: "Tune up", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false }],
    });
    expect((invoice as { numberPrefix?: string | null }).numberPrefix).toBe("AUS");

    const [still] = await raw<{ number_prefix: string | null }[]>`select number_prefix from public.job where id = ${before}`;
    expect(still!.number_prefix).toBeNull();

    // Austin's code changing later renumbers nothing already given out.
    await company.updateBusinessUnit(owner(), { id: austin, code: "ATX" });
    const [kept] = await raw<{ number_prefix: string | null }[]>`select number_prefix from public.job where id = ${job.id as string}`;
    expect(kept!.number_prefix).toBe("AUS");

    await branches.setNumbering(owner(), { jobs: false, invoices: false });
    const later = await jobs.create(owner(), {
      customerId, propertyId, summary: "After it was turned off", tags: [], customFields: {}, businessUnitId: austin,
    });
    expect((later as { numberPrefix?: string | null }).numberPrefix).toBeNull();
  });

  it("is a setting only somebody who changes settings can change", async () => {
    await expect(branches.setNumbering(as(ODA, ["office_manager"]), { jobs: true, invoices: true }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});
