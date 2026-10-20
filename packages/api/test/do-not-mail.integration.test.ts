import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError } from "@opentradesos/core";
import * as directMail from "../src/services/direct-mail";
import * as doNotMail from "../src/services/do-not-mail";
import * as leadIntake from "../src/services/lead-intake";
import * as customers from "../src/services/customers";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";
import { fakePlatform } from "./ads-fakes";

/**
 * THE DO NOT MAIL LIST, THROUGH A FAKE OF LOB
 *
 * A customer or an address can be put on the list; one already there is
 * refused in words; a flat is held alone and a building whole. Every mailing
 * checks it when it freezes who it goes to, saying in words on the piece why it
 * was skipped, and again before each batch, so a name added after the button
 * was pressed still stops the card. Taken off, the next mailing includes them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("do-not-mail:org");
const USER = fixtureId("do-not-mail:user");
const ENV = { PUBLIC_URL: "https://ots.test" };

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as ServiceContext["actor"]["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);
const readSecret = async () => "test_lob_key_not_real";

const fake = fakePlatform();
const deps = { transport: fake.transport, readSecret, env: ENV };
const printed: { to: { name: string; address_line1: string } }[] = [];
let down = false;
fake.on("POST", /^https:\/\/lob\.fake\/v1\/postcards$/, (call) => {
  if (down) return { status: 503, body: { error: { message: "Service unavailable" } } };
  const body = JSON.parse(call.body) as (typeof printed)[number];
  printed.push(body);
  return { status: 200, body: { id: `psc_${printed.length}`, expected_delivery_date: "2026-10-12" } };
});

const allowedBefore = process.env["ALLOW_PROVIDER_BASE_URL"];
const ids: Record<string, string> = {};

const person = async (name: string, line1: string, postalCode = "78704", tags = ["dnm"]) => {
  const made = await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags, customFields: {},
    property: { address: { line1, city: "Austin", state: "TX", postalCode, country: "US" } },
  });
  ids[name] = made.id as string;
  return made.id as string;
};
const mailing = (name: string, tag = "dnm") => directMail.create(owner(), {
  name, kind: "postcard", size: "4x6", audience: [{ kind: "tagged_any", tags: [tag] }],
  front: "<h1>{{ customer.firstName }}, your furnace</h1>", back: "<p>Visit {{ mail.url }}</p>",
});
const typed = (line1: string, over: Record<string, unknown> = {}) => ({
  address: { line1, city: "Austin", state: "TX", postalCode: "78704", ...over },
});

beforeAll(async () => {
  process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "No Mail Co", slug: "do-not-mail-co" });
  await raw`insert into public.location (organization_id, name, address_line1, city, state, postal_code)
            values (${ORG}, 'Office', '1 Main St', 'Austin', 'TX', '78701')`;
  await leadIntake.connect(owner(), { provider: "lob", credentialRef: "LOB_KEY", settings: { baseUrl: "https://lob.fake" } });
  await person("Ann Bell", "3 Oak Rd", "78745");
  await person("Lopez Sons", "12 Pecan St");
  await person("Cy Dunn", "7 Elm St");
  await person("Dee Flat", "9 Birch St Apt 2");
  await person("Eli Flat", "9 Birch St Apt 3");
});

afterAll(async () => {
  if (allowedBefore === undefined) delete process.env["ALLOW_PROVIDER_BASE_URL"];
  else process.env["ALLOW_PROVIDER_BASE_URL"] = allowedBefore;
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("the list", () => {
  it("takes a customer with the address they would be mailed at, and refuses them twice", async () => {
    const entry = await doNotMail.add(owner(), { customerId: ids["Ann Bell"]!, reason: "Asked on the phone, 3 June" });
    expect(entry).toMatchObject({
      kind: "customer", customerId: ids["Ann Bell"], customerName: "Ann Bell", address: "3 Oak Rd, Austin, TX, 78745",
      unit: "", reason: "Asked on the phone, 3 June",
    });
    await expect(doNotMail.add(owner(), { customerId: ids["Ann Bell"]! })).rejects.toThrow(/Ann Bell is already on your do not mail list/);
  });

  it("answers a repeated request with the first answer, and writes one entry", async () => {
    const first = await doNotMail.add(owner("dnm-key-1"), { customerId: ids["Cy Dunn"]! });
    const again = await doNotMail.add(owner("dnm-key-1"), { customerId: ids["Cy Dunn"]! });
    expect(again.id).toBe(first.id);
    const [n] = await raw<{ n: string }[]>`select count(*) as n from public.do_not_mail where customer_id = ${ids["Cy Dunn"]!} and deleted_at is null`;
    expect(Number(n!.n)).toBe(1);
    await doNotMail.remove(owner(), { id: first.id });
  });

  it("takes an address typed in, however it is written, and refuses it twice", async () => {
    const entry = await doNotMail.add(owner(), { ...typed("12 pecan street"), reason: "Landlord's letter" });
    expect(entry).toMatchObject({ kind: "address", customerId: null, address: "12 pecan street, Austin, TX, 78704", unit: "" });
    await expect(doNotMail.add(owner(), typed("12 PECAN ST."))).rejects.toThrow(/is already on your do not mail list/);
  });

  it("refuses an address that cannot be told from another, and gives one thing at a time", async () => {
    await expect(doNotMail.add(owner(), typed("12 Pecan St", { postalCode: "" }))).rejects.toThrow(/street, the town, the two letter state and the ZIP/);
    await expect(doNotMail.add(owner(), {})).rejects.toThrow(/a customer, or an address, not both and not neither/);
    await expect(doNotMail.add(owner(), { customerId: ids["Cy Dunn"]!, ...typed("1 Main St") })).rejects.toThrow(ConflictError);
    await expect(doNotMail.add(owner(), { customerId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(NotFoundError);
    await expect(doNotMail.add(owner(), { customerId: ids["Cy Dunn"]!, reason: "x".repeat(201) })).rejects.toThrow(/at most|200 characters/);
  });

  it("is added to by whoever may edit customers, read by whoever may read campaigns, and taken off by whoever may send them", async () => {
    await expect(doNotMail.add(as(["technician"]), typed("40 Cedar Ln"))).rejects.toThrow(PermissionError);
    await expect(doNotMail.list(as(["technician"]))).rejects.toThrow(PermissionError);
    /** The front desk takes the call and can put the name on; it cannot take one off, which lets mail go. */
    const entry = await doNotMail.add(as(["csr"]), typed("40 Cedar Ln"));
    await expect(doNotMail.remove(as(["csr"]), { id: entry.id })).rejects.toThrow(PermissionError);
    await expect(doNotMail.list(as(["csr"]))).rejects.toThrow(PermissionError);
    await doNotMail.remove(owner(), { id: entry.id });
  });

  it("says what stops one customer, by their name or by their door", async () => {
    const lopez = await doNotMail.list(owner(), { customerId: ids["Lopez Sons"]! });
    expect(lopez.map((e) => e.kind)).toEqual(["address"]);
    const cy = await doNotMail.list(owner(), { customerId: ids["Cy Dunn"]! });
    expect(cy).toEqual([]);
    const all = await doNotMail.list(owner());
    expect(all.map((e) => e.kind).sort()).toEqual(["address", "customer"]);
  });
});

run("a mailing", () => {
  let id = "";

  it("counts and shows who it would leave out before it goes", async () => {
    id = (await mailing("Fall tune up")).id;
    const preview = await directMail.preview(owner(), { id });
    expect(preview).toMatchObject({ selected: 5, doNotMail: 2, noAddress: 0, postable: 3 });
    expect(preview.sample.filter((s) => s.doNotMail).map((s) => s.name).sort()).toEqual(["Ann Bell", "Lopez Sons"]);
  });

  it("skips a listed customer and a listed door in words on the piece, and prints the rest", async () => {
    const report = await directMail.send(owner("dnm-send-1"), { id }, deps);
    expect(report).toMatchObject({ state: "sent", pieces: 5, sent: 3, skipped: 2 });
    expect(printed.map((p) => p.to.name).sort()).toEqual(["Cy Dunn", "Dee Flat", "Eli Flat"]);
    const pieces = await directMail.pieces(owner(), { id });
    const ann = pieces.find((p) => p.name === "Ann Bell")!;
    const lopez = pieces.find((p) => p.name === "Lopez Sons")!;
    expect(ann).toMatchObject({ status: "skipped" });
    expect(ann.reason).toBe("Not posted. Ann Bell is on your do not mail list: Asked on the phone, 3 June. Take them off the list on the Direct mail page to mail them.");
    expect(lopez.reason).toBe("Not posted. 12 Pecan St, Austin, TX, 78704 is on your do not mail list: Landlord's letter. Take them off the list on the Direct mail page to mail them.");
  });

  it("checks again before each batch, so a name added after the button was pressed still stops the card", async () => {
    printed.length = 0;
    const later = (await mailing("Winter check", "dnm")).id;
    down = true;
    const first = await directMail.send(owner("dnm-send-2"), { id: later }, deps);
    expect(first).toMatchObject({ state: "sending", sent: 0, failed: 3, skipped: 2 });
    /** Cy rings the office while the printer is down. */
    await doNotMail.add(owner(), { customerId: ids["Cy Dunn"]!, reason: "Rang to say stop" });
    down = false;
    await directMail.sendBatch(db(), ORG, later, deps);
    expect(printed.map((p) => p.to.name).sort()).toEqual(["Dee Flat", "Eli Flat"]);
    const pieces = await directMail.pieces(owner(), { id: later });
    expect(pieces.find((p) => p.name === "Cy Dunn")).toMatchObject({ status: "skipped", reason: expect.stringContaining("Rang to say stop") });
    expect((await directMail.get(owner(), { id: later })).state).toBe("sent");
  });

  it("holds a flat alone, and a building whole", async () => {
    printed.length = 0;
    await doNotMail.add(owner(), typed("9 Birch St", { line2: "Unit 3" }));
    const flats = (await mailing("Spring flats", "dnm")).id;
    const report = await directMail.send(owner("dnm-send-3"), { id: flats }, deps);
    expect(report.skipped).toBe(4);
    expect(printed.map((p) => p.to.name)).toEqual(["Dee Flat"]);

    /** Then the building: Dee is stopped too. */
    await doNotMail.add(owner(), typed("9 BIRCH STREET"));
    expect((await directMail.preview(owner(), { id: (await mailing("Summer flats", "dnm")).id })).postable).toBe(0);
  });

  it("includes them again once they are taken off the list, and keeps who took them off", async () => {
    const entries = await doNotMail.list(owner());
    const ann = entries.find((e) => e.customerId === ids["Ann Bell"])!;
    expect(await doNotMail.remove(owner(), { id: ann.id })).toEqual({ id: ann.id, removed: true });
    expect(await doNotMail.remove(owner(), { id: ann.id })).toEqual({ id: ann.id, removed: true });
    const [kept] = await raw<{ deleted_at: Date | null; removed_by_user_id: string | null }[]>`
      select deleted_at, removed_by_user_id from public.do_not_mail where id = ${ann.id}`;
    expect(kept!.deleted_at).not.toBeNull();
    expect(kept!.removed_by_user_id).toBe(USER);
    await expect(doNotMail.remove(owner(), { id: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(NotFoundError);
    await expect(doNotMail.remove(as(["technician"]), { id: ann.id })).rejects.toThrow(PermissionError);

    const preview = await directMail.preview(owner(), { id: (await mailing("Autumn", "dnm")).id });
    expect(preview.sample.find((s) => s.name === "Ann Bell")).toMatchObject({ doNotMail: false, postable: true });
    /** And can be put back: a name taken off is a new entry, not a clash with the old one. */
    expect(await doNotMail.add(owner(), { customerId: ids["Ann Bell"]! })).toMatchObject({ kind: "customer" });
  });

  it("moves a customer's entry with a merge, and leaves it where it is when the record kept is listed already", async () => {
    const lifecycle = await import("../src/services/customer-lifecycle");
    const dup = await person("Gus Dup", "50 Maple Ct", "78704", ["dnm-merge"]);
    const keep = await person("Gus Keep", "50 Maple Ct", "78704", ["dnm-merge"]);
    await doNotMail.add(owner(), { customerId: dup, reason: "Rang" });
    await lifecycle.merge(owner(), { keepId: keep, mergeId: dup });
    const kept = await doNotMail.list(owner(), { customerId: keep });
    expect(kept.some((e) => e.customerId === keep)).toBe(true);

    /** Both listed: one entry for the record kept, and the other stays where it was rather than being refused by the index. */
    const dup2 = await person("Hal Dup", "51 Maple Ct", "78704", ["dnm-merge"]);
    const keep2 = await person("Hal Keep", "51 Maple Ct", "78704", ["dnm-merge"]);
    await doNotMail.add(owner(), { customerId: dup2 });
    await doNotMail.add(owner(), { customerId: keep2 });
    await lifecycle.merge(owner(), { keepId: keep2, mergeId: dup2 });
    const live = await raw<{ customer_id: string }[]>`
      select customer_id from public.do_not_mail where customer_id in (${dup2}, ${keep2}) and deleted_at is null order by customer_id`;
    expect(live.map((r) => r.customer_id).sort()).toEqual([dup2, keep2].sort());
  });
});
