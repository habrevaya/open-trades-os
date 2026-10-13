import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as notices from "../src/services/staff-notices";
import * as tasks from "../src/services/tasks";
import * as taskRules from "../src/services/task-rules";
import * as expenses from "../src/services/expenses";
import * as inventory from "../src/services/inventory";
import * as approvals from "../src/services/purchase-approvals";
import * as apps from "../src/services/apps";
import * as fieldOps from "../src/services/field";
import { runPass } from "../src/services/workflow-worker";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import type { PushMessage, PushProvider, PushReceipt, PushTicket } from "../src/push/provider";
import type { MessagingProvider, OutboundMessage, SendResult } from "../src/comms/provider";
import { companyToday, fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * TELLING THE COMPANY'S OWN PEOPLE, THROUGH A REAL DATABASE
 *
 * Driven from the things that raise a notice (a task given to somebody, a late
 * task, an order waiting, an app asking, an expense decided, a licence running
 * out, a talk not signed) to the bell, the phone app and a text, with the push
 * service and the carrier faked at their seams. What is pinned is what a
 * person would notice: who is told and who is not, that nobody is told about
 * a record they cannot open, that each person's switches decide where it
 * goes, that a text needs their own say so and waits out quiet hours, and
 * that nobody is told twice.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("staff-notices:org");
const OWNER = fixtureId("staff-notices:owner");
const OFFICE = fixtureId("staff-notices:office");
const DISPATCH = fixtureId("staff-notices:dispatch");
const BOOKS = fixtureId("staff-notices:books");
const RAY = fixtureId("staff-notices:ray");
const BRANCH = fixtureId("staff-notices:branch");
const ZONE = "America/Chicago";
const RAY_TOKEN = "ExponentPushToken[raynoticeraynotice01]";
const RAY_MOBILE = "+15125550142";
const COMPANY_NUMBER = "+15125550100";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const office = () => as(OFFICE, ["office_manager"]);
const ray = (extra: Partial<Actor> = {}) => as(RAY, ["technician"], { technicianId: rayTech, ...extra });

let rayTech = "";
let rayMembership = "";
let north = "";
let south = "";

/** The push service, faked: records what it was handed and answers as told. */
class FakePush implements PushProvider {
  readonly name = "fake";
  sent: PushMessage[] = [];
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    return messages.map((m) => { this.sent.push(m); return { ok: true as const, id: `ticket-${this.sent.length}` }; });
  }
  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    return Object.fromEntries(ids.map((id) => [id, { ok: true as const }]));
  }
}

/** The carrier, faked at its seam: what it was asked to send, and an answer. */
class FakeSms implements MessagingProvider {
  readonly name = "fake";
  sent: OutboundMessage[] = [];
  answer: () => SendResult = () => ({ ok: true, providerMessageId: `SM${this.sent.length}` });
  async send(message: OutboundMessage): Promise<SendResult> { this.sent.push(message); return this.answer(); }
  verify() { return true; }
  parseInbound() { return null; }
  parseDelivery() { return null; }
}

async function person(userId: string, role: string, email: string, name: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}) returning id`;
  return m!.id;
}

/** Every notice a person has, read and unread, shown or not, straight from the table. */
const rowsFor = (userId: string) => raw<{
  id: string; kind: string; title: string; body: string | null; href: string; in_app: boolean; source_key: string;
}[]>`select id, kind, title, body, href, in_app, source_key from public.staff_notice
     where organization_id = ${ORG} and user_id = ${userId} order by created_at`;

const deliveriesFor = (noticeId: string) => raw<{
  id: string; channel: string; status: string; target: string; quiet: boolean; error: string | null; hold_until: Date | null;
}[]>`select id, channel, status, target, quiet, error, hold_until from public.staff_notice_delivery
     where notice_id = ${noticeId} order by channel`;

/** A quiet hours window round the company's present hour, so a pass now is inside it whatever the clock says. */
async function quietNow() {
  const hour = Math.floor(time.minutesInDay(new Date(), ZONE) / 60);
  await raw`update public.organization set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{quietHours}',
    ${raw.json({ startHour: hour, endHour: (hour + 1) % 24 })}) where id = ${ORG}`;
}
const quietOff = () => raw`update public.organization set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{quietHours}', 'null'::jsonb) where id = ${ORG}`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Notice Co", slug: "notice-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`update public."user" set name = 'Olive Owner' where id = ${OWNER}`;
  await person(OFFICE, "office_manager", "office@notice-co.test", "Oscar Office");
  await person(DISPATCH, "dispatcher", "dispatch@notice-co.test", "Dina Dispatch");
  await person(BOOKS, "accountant", "books@notice-co.test", "Beth Books");
  await person(BRANCH, "branch_manager", "branch@notice-co.test", "Bo Branch");
  rayMembership = await person(RAY, "technician", "ray@notice-co.test", "Ray Nunez");
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${rayMembership}, 'Ray Nunez') returning id`;
  rayTech = t!.id;

  const [n] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'North') returning id`;
  const [s] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'South') returning id`;
  north = n!.id;
  south = s!.id;
  await raw`update public.membership set business_unit_id = ${north} where organization_id = ${ORG} and user_id = ${BRANCH}`;
  await raw`update public.membership set business_unit_id = ${south}, reports_to_user_id = ${BRANCH} where id = ${rayMembership}`;

  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, ${COMPANY_NUMBER}, 'main', true)`;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${OFFICE}, ${DISPATCH}, ${BOOKS}, ${RAY}, ${BRANCH})`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.staff_notice_delivery where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice_setting where organization_id = ${ORG}`;
  await raw`delete from public.staff_text_consent where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.device where organization_id = ${ORG}`;
  await raw`update public.membership set revocations = '[]'::jsonb where organization_id = ${ORG}`;
  await quietOff();
  await fieldOps.register(ray(), { installationId: `ray-${crypto.randomUUID()}`, pushToken: RAY_TOKEN });
});

run("a task given to somebody", () => {
  it("tells them on the bell and their phone, once, and never the person who gave it to themselves", async () => {
    const task = await tasks.create(owner(), { title: "Call Mrs Patel back", assigneeUserId: RAY });
    const bell = await notices.list(ray());
    expect(bell.unread).toBe(1);
    expect(bell.notices[0]).toMatchObject({
      kind: "task_assigned", kindLabel: "A task given to you", title: "A task for you: Call Mrs Patel back", href: `/tasks/${task.id}`,
    });
    const [row] = await rowsFor(RAY);
    expect((await deliveriesFor(row!.id)).map((d) => d.channel)).toEqual(["push"]);

    // Saving the task again with the same person on it tells nobody again.
    await tasks.update(owner(), { id: task.id, assigneeUserId: RAY, title: "Call Mrs Patel back today" });
    expect(await rowsFor(RAY)).toHaveLength(1);

    // A task you give yourself is not news to you.
    await tasks.create(owner(), { title: "Order more filters", assigneeUserId: OWNER });
    expect(await rowsFor(OWNER)).toHaveLength(0);
  });

  it("tells whoever it is handed to next", async () => {
    const task = await tasks.create(owner(), { title: "Chase the permit" });
    expect(await rowsFor(OFFICE)).toHaveLength(0);
    await tasks.update(owner(), { id: task.id, assigneeUserId: OFFICE });
    const [row] = await rowsFor(OFFICE);
    expect(row).toMatchObject({ kind: "task_assigned", href: `/tasks/${task.id}` });
  });
});

run("never about a record they cannot open", () => {
  it("does not tell a dispatcher about a late task, since the dispatcher preset cannot open tasks; the office manager is told", async () => {
    const late = await tasks.create(owner(), { title: "Send the warranty claim", dueAt: new Date(Date.now() - 5 * 3_600_000) });
    const dispatchRule = await taskRules.createRule(owner(), { name: "Tell dispatch", afterHours: 2, target: "role", targetRole: "dispatcher" });
    const officeRule = await taskRules.createRule(owner(), { name: "Tell the office", afterHours: 2, target: "role", targetRole: "office_manager" });
    try {
      await taskRules.escalateFor(db(), ORG);
      // The escalation still says who it told, by task and email; the bell is only for who can open it.
      const [escalation] = await raw<{ notified: string[] }[]>`
        select notified from public.task_escalation where task_id = ${late.id} and rule_id = ${dispatchRule.id}`;
      expect(escalation!.notified).toContain(DISPATCH);
      expect(await rowsFor(DISPATCH)).toHaveLength(0);

      const told = await rowsFor(OFFICE);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ kind: "task_escalated", title: "Late: Send the warranty claim", href: `/tasks/${late.id}` });
      expect(told[0]!.body).toContain('Raised by the rule "Tell the office"');
      expect((await notices.list(office())).notices.map((n) => n.href)).toEqual([`/tasks/${late.id}`]);
      // A second pass escalates nothing again and tells nobody again.
      await taskRules.escalateFor(db(), ORG);
      expect(await rowsFor(OFFICE)).toHaveLength(1);
    } finally {
      await raw`delete from public.task_escalation_rule where id in (${dispatchRule.id}, ${officeRule.id})`;
    }
  });

  it("tells the approver an order waits for, and not one whose own access was narrowed to leave orders out", async () => {
    const [item] = await raw<{ id: string }[]>`
      insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'equipment', ${`COIL-${crypto.randomUUID().slice(0, 6)}`}) returning id`;
    await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
      values (${ORG}, ${item!.id}, 1, 'Evaporator coil', '1800.00', now() - interval '1 day')`;
    const [shop] = await raw<{ id: string }[]>`insert into public.location (organization_id, name, is_warehouse, address_line1, city, state)
      values (${ORG}, 'Yard', true, '1 Yard Rd', 'Austin', 'TX') returning id`;
    const vendor = await inventory.createVendor(owner(), { name: `Ferguson ${crypto.randomUUID().slice(0, 4)}` });
    const rule = await approvals.addRule(owner(), { minimumTotal: "1000", approverRole: "accountant" });
    try {
      const order = await inventory.createPurchaseOrder(owner(), {
        vendorId: vendor.id, defaultLocationId: shop!.id, lines: [{ itemId: item!.id, quantity: "1", unitPrice: "1800.00" }],
      });
      const [told] = await rowsFor(BOOKS);
      expect(told).toMatchObject({ kind: "po_approval", href: `/purchasing/${order.id}` });
      expect(told!.title).toContain("is waiting for your approval");

      // The same accountant with orders taken off their access is not told about the next one.
      await raw`update public.membership set revocations = '["po:read"]'::jsonb where organization_id = ${ORG} and user_id = ${BOOKS}`;
      await inventory.createPurchaseOrder(owner(), {
        vendorId: vendor.id, defaultLocationId: shop!.id, lines: [{ itemId: item!.id, quantity: "1", unitPrice: "1800.00" }],
      });
      expect(await rowsFor(BOOKS)).toHaveLength(1);
    } finally {
      await approvals.removeRule(owner(), { id: rule.id });
    }
  });

  it("tells somebody about their own licence running out, and their manager only once the manager may read their record", async () => {
    const today = companyToday();
    const [type] = await raw<{ id: string }[]>`insert into public.certification_type (organization_id, code, name)
      values (${ORG}, ${`epa-${crypto.randomUUID().slice(0, 6)}`}, 'EPA 608 Universal') returning id`;
    const [held] = await raw<{ id: string }[]>`insert into public.person_certification
      (organization_id, technician_id, certification_type_id, expires_on, status)
      values (${ORG}, ${rayTech}, ${type!.id}, ${companyToday(10)}, 'active') returning id`;

    await notices.raiseDueFor(db(), ORG);
    const own = await rowsFor(RAY);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ kind: "qualification_expiry", title: "Your EPA 608 Universal runs out soon", href: "/me" });
    expect(own[0]!.body).toContain(`runs out in 10 days, on ${companyToday(10)}`);
    // Bo is who Ray answers to, and runs North; Ray works in South, so Bo cannot open his record.
    expect(await rowsFor(BRANCH)).toHaveLength(0);

    // Looking again raises nothing new.
    await notices.raiseDueFor(db(), ORG);
    expect(await rowsFor(RAY)).toHaveLength(1);

    // Bo moves to South: now he can open Ray's record, and is told, on Ray's page.
    await raw`update public.membership set business_unit_id = ${south} where organization_id = ${ORG} and user_id = ${BRANCH}`;
    try {
      await notices.raiseDueFor(db(), ORG);
      const managers = await rowsFor(BRANCH);
      expect(managers).toHaveLength(1);
      expect(managers[0]).toMatchObject({ title: "Ray Nunez's EPA 608 Universal runs out soon", href: `/people/${rayMembership}` });

      // On the day, a second notice to each; a renewal recorded since stops anything more.
      await raw`update public.person_certification set expires_on = ${today} where id = ${held!.id}`;
      await notices.raiseDueFor(db(), ORG);
      expect((await rowsFor(RAY)).map((r) => r.title)).toEqual([
        "Your EPA 608 Universal runs out soon", "Your EPA 608 Universal runs out today",
      ]);
      await raw`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on, status)
        values (${ORG}, ${rayTech}, ${type!.id}, ${companyToday(700)}, 'active')`;
      await raw`delete from public.staff_notice where organization_id = ${ORG}`;
      await notices.raiseDueFor(db(), ORG);
      expect(await rowsFor(RAY)).toHaveLength(0);
    } finally {
      await raw`update public.membership set business_unit_id = ${north} where organization_id = ${ORG} and user_id = ${BRANCH}`;
      await raw`delete from public.person_certification where organization_id = ${ORG}`;
    }
  });

  it("tells somebody about a skill of theirs running out", async () => {
    const [skill] = await raw<{ id: string }[]>`insert into public.technician_skill
      (organization_id, technician_id, skill, since, evidence, expires_on)
      values (${ORG}, ${rayTech}, 'confined_space', ${companyToday(-400)}, 'Course certificate', ${companyToday()}) returning id`;
    try {
      await notices.raiseDueFor(db(), ORG);
      const [own] = await rowsFor(RAY);
      expect(own).toMatchObject({ title: "Your skill confined_space runs out today", href: "/me" });
      expect(own!.source_key).toBe(`technician_skill:${skill!.id}:today`);
    } finally {
      await raw`delete from public.technician_skill where organization_id = ${ORG}`;
    }
  });

  it("tells a person their own expense was decided, on their own page, and nobody else", async () => {
    const spent = await expenses.record(ray(), { amount: "42.50", spentOn: companyToday(), description: "Tolls to the Lakeway job" });
    await expenses.decide(owner(), { id: spent.id, decision: "refuse", reason: "Tolls are in the day rate." });
    const [told] = await rowsFor(RAY);
    expect(told).toMatchObject({ kind: "expense_decided", title: "Your $42.50 expense was refused", href: "/me/expenses" });
    expect(told!.body).toContain("Tolls are in the day rate.");
    const others = await raw`select 1 from public.staff_notice where organization_id = ${ORG} and user_id <> ${RAY}`;
    expect(others).toHaveLength(0);
  });

  it("tells whoever can approve an app, and not the office manager who can only look", async () => {
    await apps.requestInstall(db(), {
      company: "notice-co", name: "Crew Planner", permissions: ["job:read"], scopes: { job: "all" },
      redirectUri: "https://planner.example.test/back",
    }, { ip: `203.0.113.${Math.floor(Math.random() * 200)}` });
    const [told] = await rowsFor(OWNER);
    expect(told).toMatchObject({ kind: "app_request", title: "Crew Planner is asking to connect" });
    expect(told!.href).toMatch(/^\/settings\/apps\/requests\//);
    expect(await rowsFor(OFFICE)).toHaveLength(0);
  });

  it("nudges a technician an hour after a talk they have not signed, and not while it is going", async () => {
    const [held] = await raw<{ id: string }[]>`insert into public.safety_meeting (organization_id, topic, held_at)
      values (${ORG}, 'Ladders', now() - interval '2 hours') returning id`;
    const [going] = await raw<{ id: string }[]>`insert into public.safety_meeting (organization_id, topic, held_at)
      values (${ORG}, 'Heat', now() - interval '10 minutes') returning id`;
    for (const meeting of [held!.id, going!.id]) {
      await raw`insert into public.safety_meeting_attendee (organization_id, meeting_id, technician_id, name)
        values (${ORG}, ${meeting}, ${rayTech}, 'Ray Nunez')`;
    }
    try {
      await notices.raiseDueFor(db(), ORG);
      const told = await rowsFor(RAY);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ kind: "talk_unsigned", title: "Sign the toolbox talk: Ladders", href: "/my-day" });
    } finally {
      await raw`delete from public.safety_meeting where organization_id = ${ORG}`;
    }
  });

  it("stops showing a notice once the person can no longer open what it is about", async () => {
    const task = await tasks.create(owner(), { title: "Pick up the gauges", assigneeUserId: RAY });
    const [row] = await rowsFor(RAY);
    expect((await notices.list(ray())).notices).toHaveLength(1);
    const narrowed = ray({ revocations: ["task:read"] });
    expect(await notices.list(narrowed)).toEqual({ notices: [], unread: 0 });
    await expect(notices.open(narrowed, { id: row!.id })).rejects.toBeInstanceOf(NotFoundError);
    // Somebody else's notice is not found either, whatever they hold.
    await expect(notices.open(owner(), { id: row!.id })).rejects.toBeInstanceOf(NotFoundError);
    expect(await notices.open(ray(), { id: row!.id })).toEqual({ id: row!.id, href: `/tasks/${task.id}` });
  });
});

run("each person's switches", () => {
  it("keeps a kind switched off in the app off the bell, and off the phone when push is off", async () => {
    await notices.setSwitches(ray(), { kinds: [{ kind: "task_assigned", inApp: false, push: false, text: false }] });
    await tasks.create(owner(), { title: "Return the ladder", assigneeUserId: RAY });
    const [row] = await rowsFor(RAY);
    expect(row!.in_app).toBe(false);
    expect(await deliveriesFor(row!.id)).toEqual([]);
    expect((await notices.list(ray())).notices).toEqual([]);
    // Other kinds keep their defaults.
    const view = await notices.settings(ray());
    expect(view.kinds.find((k) => k.kind === "expense_decided")).toMatchObject({ inApp: true, push: true, text: false });
    expect(view.phones).toBe(1);
    expect(view.companyCanText).toBe(true);
  });

  it("will not switch texts on for a kind before the person turns texts on, and a customer's consent is not theirs", async () => {
    await expect(notices.setSwitches(ray(), { kinds: [{ kind: "expense_decided", inApp: true, push: true, text: true }] }))
      .rejects.toThrow(/Turn on texts with your mobile number first/);
    // A customer's consent for the very same number turns nothing on for staff.
    await raw`insert into public.communication_consent (organization_id, address, channel, purpose, state, method)
      values (${ORG}, ${RAY_MOBILE}, 'sms', 'transactional', 'granted', 'verbal')`;
    try {
      await expect(notices.setSwitches(ray(), { kinds: [{ kind: "expense_decided", inApp: true, push: true, text: true }] }))
        .rejects.toThrow(/Turn on texts/);
      expect((await notices.settings(ray())).texts.on).toBe(false);
    } finally {
      await raw`delete from public.communication_consent where organization_id = ${ORG}`;
    }
  });

  it("needs the box ticked and a real number, keeps the words agreed to, and only the person can turn their texts on", async () => {
    await expect(notices.setTexts(ray(), { on: true, mobilePhone: RAY_MOBILE })).rejects.toThrow(/Tick the box/);
    await expect(notices.setTexts(ray(), { on: true, mobilePhone: "call me", agreed: true })).rejects.toThrow(/mobile number/);
    const on = await notices.setTexts(ray(), { on: true, mobilePhone: "(512) 555-0142", agreed: true });
    expect(on.texts).toMatchObject({ on: true, mobile: RAY_MOBILE });
    // The same again is the first answer, not a second consent.
    await notices.setTexts(ray(), { on: true, mobilePhone: RAY_MOBILE, agreed: true });
    const consents = await raw<{ state: string; proof_text: string; superseded_at: Date | null }[]>`
      select state, proof_text, superseded_at from public.staff_text_consent where user_id = ${RAY}`;
    expect(consents).toHaveLength(1);
    expect(consents[0]!.proof_text).toBe(notices.TEXT_AGREEMENT);
    // The routes take no person: what the owner turns on is the owner's own, never Ray's.
    expect((await notices.settings(owner())).texts.on).toBe(false);
  });
});

run("sending", () => {
  it("sends a phone notice through the push service, quietly inside quiet hours, and once", async () => {
    await tasks.create(owner(), { title: "Bring the vacuum pump", assigneeUserId: RAY });
    const [row] = await rowsFor(RAY);
    const push = new FakePush();
    await quietNow();
    const result = await notices.noticesFor(db(), ORG, { push, raise: false });
    expect(result.pushed).toBe(1);
    expect(push.sent).toEqual([expect.objectContaining({
      to: RAY_TOKEN, title: "A task for you: Bring the vacuum pump", quiet: true,
      data: expect.objectContaining({ noticeId: row!.id, kind: "task_assigned", href: row!.href }),
    })]);
    expect((await deliveriesFor(row!.id))[0]).toMatchObject({ status: "sent", quiet: true });
    await notices.noticesFor(db(), ORG, { push, raise: false });
    expect(push.sent).toHaveLength(1);
  });

  it("texts the person's own mobile from the company's number when they turned it on, and once", async () => {
    await notices.setTexts(ray(), { on: true, mobilePhone: RAY_MOBILE, agreed: true });
    await notices.setSwitches(ray(), { kinds: [{ kind: "expense_decided", inApp: true, push: false, text: true }] });
    const spent = await expenses.record(ray(), { amount: "18.00", spentOn: companyToday(), description: "Parking downtown" });
    await expenses.decide(owner(), { id: spent.id, decision: "approve" });
    const [row] = await rowsFor(RAY);
    expect((await deliveriesFor(row!.id)).map((d) => [d.channel, d.target])).toEqual([["sms", RAY_MOBILE]]);

    const sms = new FakeSms();
    const result = await notices.noticesFor(db(), ORG, { push: false, sms, raise: false });
    expect(result.texted).toBe(1);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]).toMatchObject({ to: RAY_MOBILE, from: COMPANY_NUMBER });
    expect(sms.sent[0]!.body).toContain("Notice Co: Your $18.00 expense was approved");
    expect((await deliveriesFor(row!.id))[0]).toMatchObject({ status: "sent" });
    // Nothing is in the company's inbox: the text names a record only Ray may open.
    expect(await raw`select 1 from public.message where organization_id = ${ORG} and to_address = ${RAY_MOBILE}`).toHaveLength(0);
    await notices.noticesFor(db(), ORG, { push: false, sms, raise: false });
    expect(sms.sent).toHaveLength(1);
  });

  it("holds a text through quiet hours and sends it when they end", async () => {
    await notices.setTexts(ray(), { on: true, mobilePhone: RAY_MOBILE, agreed: true });
    await notices.setSwitches(ray(), { kinds: [{ kind: "task_assigned", inApp: true, push: false, text: true }] });
    await tasks.create(owner(), { title: "Check the van tyres", assigneeUserId: RAY });
    const [row] = await rowsFor(RAY);
    await quietNow();
    const sms = new FakeSms();
    const night = await notices.noticesFor(db(), ORG, { push: false, sms, raise: false });
    expect(night.held).toBe(1);
    expect(sms.sent).toHaveLength(0);
    const [held] = await deliveriesFor(row!.id);
    expect(held).toMatchObject({ status: "held" });
    const morning = new Date(held!.hold_until!.getTime() + 60_000);
    const later = await notices.noticesFor(db(), ORG, { push: false, sms, raise: false, now: () => morning });
    expect(later.texted).toBe(1);
    expect(sms.sent).toHaveLength(1);
  });

  it("does not text a number that replied STOP, or after the person turned texts off", async () => {
    await notices.setTexts(ray(), { on: true, mobilePhone: RAY_MOBILE, agreed: true });
    await notices.setSwitches(ray(), { kinds: [{ kind: "task_assigned", inApp: true, push: false, text: true }] });
    await tasks.create(owner(), { title: "First", assigneeUserId: RAY });
    await raw`insert into public.suppression (organization_id, address, channel, reason) values (${ORG}, ${RAY_MOBILE}, 'sms', 'Replied STOP')`;
    const sms = new FakeSms();
    await notices.noticesFor(db(), ORG, { push: false, sms, raise: false });
    const [first] = await rowsFor(RAY);
    expect((await deliveriesFor(first!.id))[0]).toMatchObject({ status: "skipped" });
    expect((await deliveriesFor(first!.id))[0]!.error).toMatch(/replied STOP/);
    await raw`delete from public.suppression where organization_id = ${ORG}`;

    await tasks.create(owner(), { title: "Second", assigneeUserId: RAY });
    await notices.setTexts(ray(), { on: false });
    await notices.noticesFor(db(), ORG, { push: false, sms, raise: false });
    const second = (await rowsFor(RAY))[1]!;
    expect((await deliveriesFor(second.id))[0]).toMatchObject({ status: "skipped", error: "They turned texts off before it went." });
    expect(sms.sent).toHaveLength(0);
    // And the bell still has both.
    expect((await notices.list(ray())).notices).toHaveLength(2);
  });
});

run("the worker", () => {
  it("sends what is waiting on its own pass, and leaves it waiting on a worker pass with phones turned off", async () => {
    await notices.setTexts(ray(), { on: true, mobilePhone: RAY_MOBILE, agreed: true });
    await notices.setSwitches(ray(), { kinds: [{ kind: "task_assigned", inApp: true, push: true, text: true }] });
    await tasks.create(owner(), { title: "Swap the filter", assigneeUserId: RAY });
    const push = new FakePush();
    const sms = new FakeSms();

    // A pass with phones turned off, as every other test's pass is, leaves both waiting.
    await runPass({
      db: db(), only: [ORG], schedules: false, geocoding: false, webhooks: false, backups: false, push: false,
      reviewAsks: false, agents: false, ads: false, mail: false, autopay: false, notices: { sms },
    });
    const [row] = await rowsFor(RAY);
    expect((await deliveriesFor(row!.id)).map((d) => d.status)).toEqual(["queued", "queued"]);

    expect(push.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);

    // The notice pass itself, as the worker runs it with phones on, finds the company and sends both.
    await notices.noticePass(db(), { push, sms, only: [ORG] });
    expect(push.sent.map((m) => m.title)).toEqual(["A task for you: Swap the filter"]);
    expect(sms.sent.map((m) => m.to)).toEqual([RAY_MOBILE]);
  });
});

run("reading", () => {
  it("counts the unread, and marks one or all read", async () => {
    await tasks.create(owner(), { title: "One", assigneeUserId: RAY });
    await tasks.create(owner(), { title: "Two", assigneeUserId: RAY });
    await tasks.create(owner(), { title: "Three", assigneeUserId: RAY });
    const before = await notices.list(ray());
    expect(before.unread).toBe(3);
    expect(before.notices.map((n) => n.title)).toEqual(["A task for you: Three", "A task for you: Two", "A task for you: One"]);
    await notices.markRead(ray(), { ids: [before.notices[0]!.id] });
    expect((await notices.list(ray())).unread).toBe(2);
    expect((await notices.list(ray(), { unread: true })).notices).toHaveLength(2);
    // Somebody else's ids are ignored rather than refused.
    expect(await notices.markRead(owner(), { ids: [before.notices[1]!.id] })).toEqual({ marked: 0 });
    expect(await notices.markRead(ray(), { all: true })).toEqual({ marked: 2 });
    expect((await notices.list(ray())).unread).toBe(0);
  });

  it("is a person's own: a connected app has no notices", async () => {
    const app: ServiceContext = {
      actor: { userId: "00000000-0000-0000-0000-000000000000", organizationId: ORG, roles: [], grants: ["profile:own"], agentId: "app:x" },
      db: db(),
    };
    await expect(notices.list(app)).rejects.toThrow(/for a person signed in/);
  });
});
