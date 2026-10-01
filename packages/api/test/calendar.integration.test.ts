import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as calendar from "../src/services/calendar";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import {
  renderCalendar, escapeText, foldLine, utcStamp, sequenceFor, MAX_OCTETS,
} from "../src/calendar/ics";
import "../src/calendar/index";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A CALENDAR FEED THAT IS WRONG IS WORSE THAN NO CALENDAR FEED
 *
 * Every way of getting this wrong produces a file that parses. The
 * technician's phone fills up, nothing errors, and the day shown is not the
 * day they are working. Four copies of Tuesday, a two o'clock visit drawn at
 * seven in the morning, an address that ends halfway through a street name:
 * all of those are green suites and a technician who stops trusting the
 * feed.
 *
 * So the framing is tested first and without a database, because the framing
 * is the part that is hard to get right, and then the service is tested
 * against real rows for the things only real rows can show: that the feed
 * contains this technician's visits and nobody else's, that the token is the
 * whole of the authentication and a revoked one reaches nothing, and that
 * the customer's phone number is not in it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("calendar:org");
const USER = fixtureId("calendar:user");
const TECH_USER = fixtureId("calendar:tech-user");

let raw: postgres.Sql;
let technicianId: string;
let otherTechnicianId: string;

const db = () => testDb(url!);
const ctx = (over: Partial<Actor> = {}): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"], ...over,
  },
  db: db(),
});

/** The technician themselves: visit:read and no integration permission at all. */
const techCtx = (): ServiceContext => ({
  actor: { userId: TECH_USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] },
  db: db(),
});

const dispatcherCtx = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] },
  db: db(),
});

/* ====================================================== the file format */

describe("folding a content line at 75 octets", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:Short")).toBe("SUMMARY:Short");
  });

  it("breaks a long line and starts every continuation with one space", () => {
    const line = `DESCRIPTION:${"a".repeat(300)}`;
    const folded = foldLine(line);
    const parts = folded.split("\r\n");

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.length).toBe(MAX_OCTETS);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(" "), "a continuation line must begin with a space").toBe(true);
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(MAX_OCTETS);
    }
  });

  it("unfolds back to exactly what went in", () => {
    /**
     * The property that matters. Folding is only correct if a parser
     * following the specification, which strips a CRLF followed by a single
     * whitespace character, gets the original string back byte for byte.
     */
    const line = `LOCATION:${"14 Elm Street, Apartment 4B, Austin, TX 78702 ".repeat(6)}`;
    expect(foldLine(line).replace(/\r\n /g, "")).toBe(line);
  });

  it("never splits a multi-byte character across the fold", () => {
    /**
     * The limit is 75 OCTETS, not characters. A street name with an accent
     * in it, or an emoji somebody put in a job summary, sits across the
     * boundary, and cutting it in half puts a replacement character in the
     * middle of an address and makes some parsers abandon the property.
     */
    const line = `SUMMARY:${"é".repeat(80)}`;
    const folded = foldLine(line);
    expect(folded).not.toContain("\uFFFD");
    expect(folded.replace(/\r\n /g, "")).toBe(line);
    for (const part of folded.split("\r\n")) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(MAX_OCTETS);
    }
  });

  it("counts octets rather than characters when deciding to fold at all", () => {
    /** Forty characters, eighty octets. A character count would leave it unfolded. */
    const line = "X:" + "é".repeat(40);
    expect(line.length).toBeLessThan(MAX_OCTETS);
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(MAX_OCTETS);
    expect(foldLine(line)).toContain("\r\n ");
  });
});

describe("escaping a TEXT value", () => {
  it("escapes a comma, which is a value separator unescaped", () => {
    /** "Austin, TX" unescaped turns one LOCATION into a list of two. */
    expect(escapeText("Austin, TX")).toBe("Austin\\, TX");
  });

  it("escapes a semicolon", () => {
    expect(escapeText("Gate code; ring twice")).toBe("Gate code\\; ring twice");
  });

  it("escapes a backslash, and does it before everything else", () => {
    /**
     * Order is the whole of this one. Escaping the comma first and the
     * backslash second would escape the backslash that was just inserted,
     * producing `\\,` where `\,` was meant, which a parser reads as a
     * literal backslash followed by a separator.
     */
    expect(escapeText("C:\\jobs, today")).toBe("C:\\\\jobs\\, today");
  });

  it("turns a newline into the escape rather than ending the property", () => {
    expect(escapeText("Line one\nLine two")).toBe("Line one\\nLine two");
    expect(escapeText("Line one\r\nLine two")).toBe("Line one\\nLine two");
  });

  it("leaves a colon alone, because it is ordinary inside TEXT", () => {
    expect(escapeText("Arrive: 2pm")).toBe("Arrive: 2pm");
  });

  it("drops a control character there is no escape for", () => {
    expect(escapeText("Ring\u0007the bell")).toBe("Ringthe bell");
  });

  it("keeps a tab, which RFC 5545 allows inside a TEXT value", () => {
    /**
     * The opposite direction, and the reason the strip is a code point
     * filter rather than "anything below a space". Dropping a tab out of a
     * pasted gate code changes what the technician reads.
     */
    expect(escapeText("Gate\t1234")).toBe("Gate\t1234");
  });
});

describe("the instants", () => {
  it("writes every time in UTC with the Z suffix", () => {
    /**
     * The classic failure is a local wall time with no zone, which a client
     * reads as floating and draws in whatever zone the phone is in: a two
     * o'clock visit in Austin shown at seven in the morning in London.
     */
    expect(utcStamp(new Date("2026-04-01T14:00:00.000-05:00"))).toBe("20260401T190000Z");
  });

  it("drops the milliseconds, which the format has no room for", () => {
    expect(utcStamp(new Date("2026-04-01T19:00:00.123Z"))).toBe("20260401T190000Z");
  });

  it("gives a later change a higher sequence", () => {
    const earlier = sequenceFor(new Date("2026-04-01T10:00:00Z"));
    const later = sequenceFor(new Date("2026-04-01T10:00:30Z"));
    expect(later).toBeGreaterThan(earlier);
  });

  it("keeps the sequence inside the range a client will accept", () => {
    /**
     * Several clients hold SEQUENCE in a signed 32-bit column. Counting
     * seconds from the Unix epoch crosses that ceiling in 2038, which is
     * inside the working life of a scheduling system.
     */
    expect(sequenceFor(new Date("2080-01-01T00:00:00Z"))).toBeLessThan(2 ** 31 - 1);
    expect(sequenceFor(new Date("2019-01-01T00:00:00Z"))).toBe(0);
  });
});

describe("the document", () => {
  const event = (over: Partial<Parameters<typeof renderCalendar>[0]["events"][number]> = {}) => ({
    uid: "visit-1@visits.opentradesos",
    start: new Date("2026-04-01T19:00:00Z"),
    end: new Date("2026-04-01T21:00:00Z"),
    summary: "Raman: AC not cooling",
    location: "14 Elm St, Austin, TX, 78702",
    description: "Job 1042",
    status: "CONFIRMED" as const,
    lastModified: new Date("2026-03-30T08:00:00Z"),
    ...over,
  });

  const render = (events: ReturnType<typeof event>[]) =>
    renderCalendar({ name: "Sam: visits", timezone: "America/Chicago", refreshMinutes: 60, events });

  it("produces something a client will open at all", () => {
    const text = render([event()]);
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text).toContain("VERSION:2.0");
    expect(text).toContain("METHOD:PUBLISH");
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("separates every line with CRLF and not with a bare newline", () => {
    const text = render([event()]);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses two events under one UID", () => {
    /**
     * THE DEFECT THIS WHOLE FEATURE HAS TO AVOID. A client meeting two
     * VEVENTs with one UID either shows the visit twice or picks one
     * arbitrarily, and the person holding the phone cannot tell which. It is
     * always a bug on our side rather than bad data, so it throws rather
     * than being emitted.
     */
    expect(() => render([event(), event({ summary: "Second copy" })]))
      .toThrow(/UID/);
  });

  it("keeps a UID stable across two renders of the same visit", () => {
    const first = render([event()]);
    const second = render([event()]);
    const uid = (text: string) => /UID:(.+)\r\n/.exec(text)?.[1];
    expect(uid(first)).toBe(uid(second));
  });

  it("does not move DTSTAMP when nothing about the visit changed", () => {
    /**
     * A DTSTAMP taken from the clock at the moment of the fetch says the
     * event changed on every poll. Some clients re-alert on that, so a
     * technician gets a notification an hour for a visit nobody touched.
     */
    const first = render([event()]);
    const second = render([event()]);
    const stamp = (text: string) => /DTSTAMP:(.+)\r\n/.exec(text)?.[1];
    expect(stamp(first)).toBe(stamp(second));
    expect(stamp(first)).toBe("20260330T080000Z");
  });

  it("raises the sequence when the visit changes and not before", () => {
    const before = render([event()]);
    const after = render([event({ lastModified: new Date("2026-03-31T08:00:00Z") })]);
    const seq = (text: string) => Number(/SEQUENCE:(\d+)\r\n/.exec(text)?.[1]);
    expect(seq(after)).toBeGreaterThan(seq(before));
  });

  it("emits a cancelled visit rather than dropping it", () => {
    /**
     * Most clients remove an event that disappears from a feed and some
     * keep it, and the difference is a technician driving to a job that was
     * called off. An explicit CANCELLED is the only form every client agrees
     * about.
     */
    expect(render([event({ status: "CANCELLED" })])).toContain("STATUS:CANCELLED");
  });

  it("gives an inverted window a positive length rather than dropping the visit", () => {
    const text = render([event({
      start: new Date("2026-04-01T19:00:00Z"),
      end: new Date("2026-04-01T18:00:00Z"),
    })]);
    expect(text).toContain("DTSTART:20260401T190000Z");
    expect(text).toContain("DTEND:20260401T190100Z");
  });

  it("does not escape a URL, which is not a TEXT value", () => {
    const text = render([event({ url: "https://example.test/jobs/abc?a=1,2" })]);
    expect(text).toContain("URL:https://example.test/jobs/abc?a=1,2");
  });
});

/* ==================================================== the feed in anger */

const ADDRESS = {
  line1: "14 Elm Street", city: "Austin", state: "TX", postalCode: "78702", country: "US",
} as const;

async function seedTechnicians(): Promise<void> {
  const [membership] = await raw<{ id: string }[]>`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  await raw`insert into public."user" (id, email) values (${TECH_USER}, 'calendar-tech@test.local')
    on conflict (id) do nothing`;
  const [techMembership] = await raw<{ id: string }[]>`insert into public.membership
    (organization_id, user_id, role) values (${ORG}, ${TECH_USER}, 'technician') returning id`;

  const [tech] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name)
    values (${ORG}, ${techMembership!.id}, 'Sam Ortiz') returning id`;
  technicianId = tech!.id;

  const [other] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Dale Fisher') returning id`;
  otherTechnicianId = other!.id;
}

/** One visit, at a known time, for a named customer, assigned to somebody. */
async function aVisit(input: {
  at: Date; summary: string; customerName: string; phone: string; assignTo?: string | undefined;
}): Promise<{ visitId: string; jobId: string; customerId: string }> {
  const customer = await customers.create(ctx(), {
    type: "residential", name: input.customerName, phone: input.phone,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(ctx(), {
    address: { ...ADDRESS }, hasDog: false, customFields: {},
    customerId: customer.id, customerRole: "owner",
  });
  const job = await jobs.create(ctx(), {
    customerId: customer.id, propertyId: property.id, summary: input.summary,
    tags: [], customFields: {},
  });
  const visit = await jobs.addVisit(ctx(), {
    id: job.id,
    windowStart: input.at.toISOString(),
    windowEnd: new Date(input.at.getTime() + 2 * 3600_000).toISOString(),
    estimatedDurationMinutes: 120,
    technicianIds: input.assignTo ? [input.assignTo] : [],
  });
  return { visitId: visit.id, jobId: job.id, customerId: customer.id };
}

const tokenOf = (path: string) => path.replace("/api/calendar/", "");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Calendar Co", slug: "calendar-co" });
  await seedTechnicians();
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id = ${TECH_USER}`;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Calendar Co", slug: "calendar-co" });
  await seedTechnicians();
});

run("minting a feed", () => {
  it("hands the URL over once and never again", async () => {
    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    expect(feed.feedPath).toMatch(/^\/api\/calendar\/[A-Za-z0-9_-]{40,}$/);

    const listed = await calendar.list(ctx());
    const found = listed.find((f) => f.id === feed.id)!;
    expect(Object.keys(found)).not.toContain("feedPath");
    expect(JSON.stringify(found)).not.toContain(tokenOf(feed.feedPath));
  });

  it("stores no part of the token that could be used to reach the feed", async () => {
    /**
     * The stored value is a hash. Anybody who reads the table, a backup or a
     * support export has the row and not the access, which is the whole
     * reason this differs from the lead connector's token beside it.
     */
    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const token = tokenOf(feed.feedPath);
    const [row] = await raw<{ token_hash: string; hint: string }[]>`
      select token_hash, hint from public.calendar_feed where id = ${feed.id}`;
    expect(row!.token_hash).not.toBe(token);
    expect(token).toContain(row!.hint);
    expect(row!.hint.length).toBeLessThan(10);
  });

  it("lets a technician mint a feed of their own day", async () => {
    const feed = await calendar.create(techCtx(), { scope: "technician" });
    expect(feed.technicianId).toBe(technicianId);
  });

  it("refuses a technician a feed of somebody else's day", async () => {
    /**
     * A standing read of where another person will be all week is the same
     * authority as arranging their day, so it is gated on the permission
     * that governs that and a technician does not hold it.
     */
    await expect(calendar.create(techCtx(), {
      scope: "technician", technicianId: otherTechnicianId,
    })).rejects.toThrow(/permission|visit:dispatch/i);
  });

  it("lets a dispatcher mint one over somebody else's day", async () => {
    const feed = await calendar.create(dispatcherCtx(), {
      scope: "technician", technicianId: otherTechnicianId,
    });
    expect(feed.technicianId).toBe(otherTechnicianId);
  });

  it("refuses a dispatcher the company wide feed", async () => {
    /**
     * A company feed is every customer address the company serves, in one
     * file, behind one URL that needs no session. That is a standing export
     * to an outside system, which is a different decision from running the
     * board.
     */
    await expect(calendar.create(dispatcherCtx(), { scope: "company" }))
      .rejects.toThrow(/permission|integration:write/i);
  });

  it("allows the company feed to whoever may connect an integration", async () => {
    const feed = await calendar.create(ctx(), { scope: "company" });
    expect(feed.scope).toBe("company");
    expect(feed.technicianId).toBeNull();
  });

  it("refuses a company feed that names a technician", async () => {
    await expect(calendar.create(ctx(), { scope: "company", technicianId }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses a technician feed for an account that is not a technician", async () => {
    const [membership] = await raw<{ id: string }[]>`select id from public.membership
      where organization_id = ${ORG} and user_id = ${USER}`;
    await raw`delete from public.technician where id = ${otherTechnicianId}
      and membership_id = ${membership!.id}`;
    await expect(calendar.create(ctx(), { scope: "technician" }))
      .rejects.toThrow(/not a technician/i);
  });
});

run("what the feed contains", () => {
  it("shows the visits this technician is assigned and nobody else's", async () => {
    const at = new Date(Date.now() + 86_400_000);
    await aVisit({ at, summary: "AC not cooling", customerName: "Priya Raman", phone: "+15125550123", assignTo: technicianId });
    await aVisit({ at, summary: "Water heater", customerName: "Other Household", phone: "+15125550999", assignTo: otherTechnicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));

    expect(rendered!.body).toContain("AC not cooling");
    expect(rendered!.body).not.toContain("Water heater");
  });

  it("puts the address in, because navigating to it is what the feed is for", async () => {
    const at = new Date(Date.now() + 86_400_000);
    await aVisit({ at, summary: "AC not cooling", customerName: "Priya Raman", phone: "+15125550123", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));

    expect(rendered!.body).toContain("LOCATION:14 Elm Street");
    expect(rendered!.body).toContain("Austin");
  });

  it("keeps the customer's phone number out of it", async () => {
    /**
     * THE PRIVACY DECISION, asserted rather than described in a comment
     * somebody can edit. A subscription is collected by a phone that may be
     * signed into a personal account, shared with a household and read out
     * by an assistant. The address is needed to arrive; the number is needed
     * to contact, which happens in the field app with the consent rules
     * applied.
     */
    const at = new Date(Date.now() + 86_400_000);
    await aVisit({ at, summary: "AC not cooling", customerName: "Priya Raman", phone: "+15125550123", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));

    expect(rendered!.body).not.toContain("5125550123");
    expect(rendered!.body).not.toContain("+1512");
    /** And it says where the number is, rather than leaving a silence. */
    expect(rendered!.body).toContain("phone number");
  });

  it("escapes a customer name with a comma in it", async () => {
    /**
     * "Pesto, Sr." is an ordinary name and a raw comma turns one SUMMARY
     * into a list, which some clients render as the first fragment alone.
     */
    const at = new Date(Date.now() + 86_400_000);
    await aVisit({ at, summary: "Annual service", customerName: "Jimmy Pesto, Sr.", phone: "+15125550133", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));
    expect(rendered!.body).toContain("Jimmy Pesto\\, Sr.");
  });

  it("gives the same visit the same UID on a second fetch", async () => {
    /**
     * The one that produces four copies of Tuesday. A UID that moves between
     * fetches makes every refresh a new event, and nothing errors.
     */
    const at = new Date(Date.now() + 86_400_000);
    const { visitId } = await aVisit({ at, summary: "AC not cooling", customerName: "Priya Raman", phone: "+15125550123", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const first = await calendar.render(db(), tokenOf(feed.feedPath));
    const second = await calendar.render(db(), tokenOf(feed.feedPath));

    const uids = (text: string) => [...text.matchAll(/UID:(.+)\r\n/g)].map((m) => m[1]);
    expect(uids(first!.body)).toEqual(uids(second!.body));
    expect(uids(first!.body)[0]).toContain(visitId);
  });

  it("emits one event for a visit two technicians are on", async () => {
    /**
     * A join against assignments turns one visit into two rows and two rows
     * into two identical events. The renderer refuses such a document, so
     * this is a failed fetch rather than a doubled calendar, and either way
     * it must not happen.
     */
    const at = new Date(Date.now() + 86_400_000);
    const { visitId } = await aVisit({ at, summary: "Two handed job", customerName: "Big House", phone: "+15125550144", assignTo: technicianId });
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visitId}, ${otherTechnicianId})`;

    const feed = await calendar.create(ctx(), { scope: "company" });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));
    expect([...rendered!.body.matchAll(/BEGIN:VEVENT/g)]).toHaveLength(1);
    expect(rendered!.body).toContain("Sam Ortiz");
    expect(rendered!.body).toContain("Dale Fisher");
  });

  it("shows the visit at the instant it is actually at", async () => {
    const at = new Date("2026-04-01T19:00:00.000Z");
    await aVisit({ at, summary: "Afternoon call", customerName: "Clock Watcher", phone: "+15125550155", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath), {
      now: new Date("2026-03-30T12:00:00Z"),
    });
    expect(rendered!.body).toContain("DTSTART:20260401T190000Z");
  });

  it("leaves out a visit with no time on it", async () => {
    /**
     * A visit with no window is not an appointment yet. Putting it on a
     * calendar would mean inventing a time for it.
     */
    const at = new Date(Date.now() + 86_400_000);
    const { visitId } = await aVisit({ at, summary: "Not scheduled yet", customerName: "No Window", phone: "+15125550177", assignTo: technicianId });
    await raw`update public.visit set window_start = null, window_end = null where id = ${visitId}`;

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));
    expect(rendered!.body).not.toContain("Not scheduled yet");
  });

  it("leaves out a visit beyond the window the feed covers", async () => {
    const at = new Date(Date.now() + 200 * 86_400_000);
    await aVisit({ at, summary: "Next year sometime", customerName: "Far Future", phone: "+15125550188", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));
    expect(rendered!.body).not.toContain("Next year sometime");
  });

  it("carries a cancelled visit as cancelled rather than removing it", async () => {
    const at = new Date(Date.now() + 86_400_000);
    const { visitId } = await aVisit({ at, summary: "Called off", customerName: "Changed Mind", phone: "+15125550199", assignTo: technicianId });
    await raw`update public.visit set status = 'cancelled' where id = ${visitId}`;

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));
    expect(rendered!.body).toContain("Called off");
    expect(rendered!.body).toContain("STATUS:CANCELLED");
  });

  it("moves DTSTAMP when the ADDRESS changes, not only when the visit does", async () => {
    /**
     * The visit row is untouched when somebody corrects the street. A
     * DTSTAMP tracking only the visit leaves every subscribed client showing
     * the old address, and the technician drives to it.
     */
    const at = new Date(Date.now() + 86_400_000);
    const { jobId } = await aVisit({ at, summary: "Moved house", customerName: "Wrong Street", phone: "+15125550200", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const before = await calendar.render(db(), tokenOf(feed.feedPath));

    await raw`update public.property set address_line1 = '22 Oak Street', updated_at = now() + interval '1 minute'
      where id = (select property_id from public.job where id = ${jobId})`;

    const after = await calendar.render(db(), tokenOf(feed.feedPath));
    const stamp = (text: string) => /DTSTAMP:(.+)\r\n/.exec(text)?.[1];
    expect(after!.body).toContain("22 Oak Street");
    expect(stamp(after!.body)).not.toBe(stamp(before!.body));
  });

  it("includes work dispatched to a crew the technician is on", async () => {
    const at = new Date(Date.now() + 86_400_000);
    const [crew] = await raw<{ id: string }[]>`insert into public.crew
      (organization_id, name) values (${ORG}, 'Install crew') returning id`;
    await raw`insert into public.crew_member (organization_id, crew_id, technician_id)
      values (${ORG}, ${crew!.id}, ${technicianId})`;

    const { visitId } = await aVisit({ at, summary: "Crew install", customerName: "New Build", phone: "+15125550211" });
    await raw`update public.visit set crew_id = ${crew!.id} where id = ${visitId}`;

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const rendered = await calendar.render(db(), tokenOf(feed.feedPath));
    expect(rendered!.body).toContain("Crew install");
  });
});

run("the token is the whole of the authentication", () => {
  it("answers nothing for a token nobody minted", async () => {
    expect(await calendar.render(db(), "not-a-real-token")).toBeNull();
  });

  it("stops working the moment it is revoked", async () => {
    const at = new Date(Date.now() + 86_400_000);
    await aVisit({ at, summary: "AC not cooling", customerName: "Priya Raman", phone: "+15125550123", assignTo: technicianId });

    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const token = tokenOf(feed.feedPath);
    expect(await calendar.render(db(), token)).not.toBeNull();

    await calendar.revoke(ctx(), { id: feed.id, reason: "Phone lost" });
    expect(await calendar.render(db(), token)).toBeNull();
  });

  it("records a second revoke without treating it as an error", async () => {
    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    await calendar.revoke(ctx(), { id: feed.id });
    const again = await calendar.revoke(ctx(), { id: feed.id });
    expect(again.alreadyRevoked).toBe(true);
  });

  it("kills the old URL in the same breath as minting the new one", async () => {
    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    const old = tokenOf(feed.feedPath);

    const rotated = await calendar.rotate(ctx(), { id: feed.id });
    expect(rotated.replaced).toBe(feed.id);
    expect(await calendar.render(db(), old)).toBeNull();
    expect(await calendar.render(db(), tokenOf(rotated.feedPath))).not.toBeNull();
  });

  it("lets a technician revoke their own feed without finding an administrator", async () => {
    const feed = await calendar.create(techCtx(), { scope: "technician" });
    const revoked = await calendar.revoke(techCtx(), { id: feed.id, reason: "Lost my phone" });
    expect(revoked.revokedAt).not.toBeNull();
  });

  it("refuses a technician revoking somebody else's", async () => {
    const feed = await calendar.create(ctx(), { scope: "technician", technicianId: otherTechnicianId });
    await expect(calendar.revoke(techCtx(), { id: feed.id })).rejects.toThrow(ConflictError);
  });

  it("writes down that somebody collected it, and what", async () => {
    const feed = await calendar.create(ctx(), { scope: "technician", technicianId });
    await calendar.render(db(), tokenOf(feed.feedPath), { userAgent: "Google-Calendar-Importer" });

    const [row] = await raw<{ last_fetched_at: Date | null; last_fetched_by: string | null }[]>`
      select last_fetched_at, last_fetched_by from public.calendar_feed where id = ${feed.id}`;
    expect(row!.last_fetched_at).not.toBeNull();
    expect(row!.last_fetched_by).toBe("Google-Calendar-Importer");
  });

  it("shows a technician their own feeds and not the company's", async () => {
    await calendar.create(ctx(), { scope: "company" });
    const theirs = await calendar.create(techCtx(), { scope: "technician" });

    const listed = await calendar.list(techCtx());
    expect(listed.map((f) => f.id)).toEqual([theirs.id]);
  });
});
