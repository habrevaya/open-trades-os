import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { can, type Actor } from "@opentradesos/core";
import * as search from "../src/services/search";
import { memberActor } from "../src/services/session";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE SEARCH BOX FINDS VISITS AND MESSAGES, AND ONLY THOSE ITS READERS MAY OPEN
 *
 * A visit is found through its job and the reader's visit scope, and a message
 * through its conversation's scope, each behind the permission that reads it.
 * Written as refusals first: the visit and the thread outside a person's work
 * are named and asserted absent, as the technician, as somebody who may read
 * visits and not messages, and as another company's owner.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("svm:org");
const OWNER = fixtureId("svm:owner");
const TECH = fixtureId("svm:tech");
const BOOKS = fixtureId("svm:books");
const OTHER = fixtureId("svm:other-org");
const OTHER_OWNER = fixtureId("svm:other-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const otherOwner = (): ServiceContext => ({
  actor: { userId: OTHER_OWNER, organizationId: OTHER, roles: ["owner"] as Actor["roles"] }, db: db(),
});
let tech: ServiceContext;
let books: ServiceContext;

interface Work { customer: string; job: string; jobNumber: number; visit: string; thread: string; message: string }
let ada: Work;
let bea: Work;
let theirs: Work;
let strayThread = "";

async function work(
  org: string, name: string, n: number, notes: string, said: string, subject: string,
): Promise<Work> {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${org}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${`${n} Quartz Lane`}, 'Austin', 'TX', '78701') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary) values (${org}, ${c!.id}, ${p!.id}, true)`;
  const [j] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${org}, ${n}, ${c!.id}, ${p!.id}, 'scheduled', 'Basalt repair') returning id`;
  const [v] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, technician_notes, window_start)
    values (${org}, ${j!.id}, 'scheduled', ${notes}, '2026-11-05T03:30:00Z') returning id`;
  const [t] = await raw<{ id: string }[]>`insert into public.conversation (organization_id, channel, external_address, customer_id, job_id, status)
    values (${org}, 'sms', ${`+1512555${n}`}, ${c!.id}, ${j!.id}, 'open') returning id`;
  const [m] = await raw<{ id: string }[]>`insert into public.message
    (organization_id, conversation_id, direction, channel, from_address, to_address, body, subject, status)
    values (${org}, ${t!.id}, 'inbound', 'sms', ${`+1512555${n}`}, '+15125550000', ${said}, ${subject}, 'received') returning id`;
  return { customer: c!.id, job: j!.id, jobNumber: n, visit: v!.id, thread: t!.id, message: m!.id };
}

async function person(userId: string, email: string, name: string, role: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}::public.member_role) returning id`;
  return m!.id;
}

async function resolve(userId: string): Promise<ServiceContext> {
  const actor = await inTenant(owner(), (tx) => memberActor(tx, ORG, userId));
  if (!actor) throw new Error("No active membership.");
  return { actor, db: db() };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Visits Messages Co", slug: "visits-messages-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_OWNER, name: "Visits Neighbour Co", slug: "visits-messages-neighbour" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;

  ada = await work(ORG, "Ada Quartz", 8201, "Gate code is rhubarb seven", "Please call about the rhubarb order", "Re: rhubarb");
  bea = await work(ORG, "Bea Quartz", 8202, "Dog in the yard, rhubarb patch", "Thanks, see you Monday about the rhubarb", "Monday");
  theirs = await work(OTHER, "Cy Quartz", 8203, "Gate code is rhubarb nine", "rhubarb for you", "rhubarb");
  /** A thread attached to no job and no customer: a lead, the office's to answer. */
  const [stray] = await raw<{ id: string }[]>`insert into public.conversation (organization_id, channel, external_address, status)
    values (${ORG}, 'sms', '+15125559999', 'open') returning id`;
  strayThread = stray!.id;
  await raw`insert into public.message (organization_id, conversation_id, direction, channel, from_address, to_address, body, status)
    values (${ORG}, ${strayThread}, 'inbound', 'sms', '+15125559999', '+15125550000', 'A stranger asks about rhubarb pricing', 'received')`;

  const techMembership = await person(TECH, "svm-tech@test.local", "Tia Tech", "technician");
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${techMembership}, 'Tia Tech') returning id`;
  /** Sent to Ada's visit and only that one. */
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${ada.visit}, ${t!.id})`;
  await person(BOOKS, "svm-books@test.local", "Bo Books", "accountant");

  tech = await resolve(TECH);
  books = await resolve(BOOKS);
});

afterAll(async () => { if (raw) await raw.end(); });

type Found = Awaited<ReturnType<typeof search.everything>>;
const hits = (found: Found, key: string): string[] => found.groups.find((g) => g.key === key)?.hits.map((h) => h.id) ?? [];

run("refusals: nobody finds a visit or a message outside what they may open", () => {
  it("a technician finds the visit and the thread of the job they were sent to, and no other", async () => {
    const found = await search.everything(tech, { q: "rhubarb" });
    expect(hits(found, "visits")).toEqual([ada.visit]);
    expect(hits(found, "messages")).toEqual([ada.message]);
    for (const id of [bea.visit, bea.message, theirs.visit, theirs.message]) {
      expect(found.groups.flatMap((g) => g.hits.map((h) => h.id))).not.toContain(id);
    }
  });

  it("a technician does not find a lead that is attached to nothing", async () => {
    const found = await search.everything(tech, { q: "pricing" });
    expect(hits(found, "messages")).toEqual([]);
  });

  it("somebody who may read visits and not messages gets the visit group and no message group", async () => {
    expect(can(books.actor, "visit:read")).toBe(true);
    expect(can(books.actor, "message:read")).toBe(false);
    const found = await search.everything(books, { q: "rhubarb" });
    expect(hits(found, "visits").sort()).toEqual([ada.visit, bea.visit].sort());
    expect(found.groups.find((g) => g.key === "messages")).toBeUndefined();
    const alone = await search.everything(books, { q: "rhubarb", in: "messages" });
    expect(alone.groups).toEqual([]);
  });

  it("another company's owner finds only their own", async () => {
    const found = await search.everything(otherOwner(), { q: "rhubarb" });
    expect(hits(found, "visits")).toEqual([theirs.visit]);
    expect(hits(found, "messages")).toEqual([theirs.message]);
  });
});

run("what the owner finds", () => {
  it("finds a visit by its notes, its job and its customer, and says which day in the company's calendar", async () => {
    const byNote = await search.everything(owner(), { q: "gate code" });
    expect(hits(byNote, "visits").sort()).toEqual([ada.visit]);
    const group = byNote.groups.find((g) => g.key === "visits")!;
    expect(group.label).toBe("Visits");
    expect(group.hits[0]).toMatchObject({
      title: "Visit 1 on job 8201: Basalt repair", href: `/visits/${ada.visit}`, close: false,
    });
    // 03:30 UTC on the 5th is the evening of the 4th in Chicago.
    expect(group.hits[0]!.detail).toBe("Ada Quartz, Nov 4, 2026");
    expect(group.seeAll).toBe(`/search?${new URLSearchParams({ q: "gate code", in: "visits" })}`);

    const byCustomer = await search.everything(owner(), { q: "bea quartz" });
    expect(hits(byCustomer, "visits")).toEqual([bea.visit]);
    const byNumber = await search.everything(owner(), { q: String(ada.jobNumber) });
    expect(hits(byNumber, "visits")).toContain(ada.visit);
  });

  it("finds a message by its body and its subject, and opens its thread", async () => {
    const byBody = await search.everything(owner(), { q: "see you monday" });
    expect(hits(byBody, "messages")).toEqual([bea.message]);
    const group = byBody.groups.find((g) => g.key === "messages")!;
    expect(group.hits[0]).toMatchObject({ title: "Bea Quartz", href: `/inbox/${bea.thread}` });
    expect(group.hits[0]!.detail).toContain("Monday");

    const bySubject = await search.everything(owner(), { q: "re: rhubarb" });
    expect(hits(bySubject, "messages")).toContain(ada.message);
    // A thread with no customer is named by its address.
    const stray = await search.everything(owner(), { q: "pricing" });
    expect(stray.groups.find((g) => g.key === "messages")!.hits[0]).toMatchObject({ title: "+15125559999" });
  });

  it("does not find a message that was deleted, or one in a deleted thread", async () => {
    await raw`update public.message set deleted_at = now() where id = ${bea.message}`;
    expect(hits(await search.everything(owner(), { q: "see you monday" }), "messages")).toEqual([]);
    await raw`update public.message set deleted_at = null where id = ${bea.message}`;
    await raw`update public.conversation set deleted_at = now() where id = ${bea.thread}`;
    expect(hits(await search.everything(owner(), { q: "see you monday" }), "messages")).toEqual([]);
    await raw`update public.conversation set deleted_at = null where id = ${bea.thread}`;
  });

  it("looks close for a word a letter off, after the exact ones, as every group does", async () => {
    const found = await search.everything(owner(), { q: "rhubarbs order" });
    // "rhubarbs" is not written; "rhubarb" is a letter off, and "order" is written.
    const group = found.groups.find((g) => g.key === "messages");
    expect(group?.hits.map((h) => h.id)).toEqual([ada.message]);
    expect(group?.hits[0]?.close).toBe(true);
  });

  it("shows one group alone at fifty, for the groups with no list screen", async () => {
    const alone = await search.everything(owner(), { q: "rhubarb", in: "visits" });
    expect(alone.groups.map((g) => g.key)).toEqual(["visits"]);
    expect(alone.groups[0]!.seeAll).toBeNull();
  });
});
