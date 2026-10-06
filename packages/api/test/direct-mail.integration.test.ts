import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as directMail from "../src/services/direct-mail";
import * as leadIntake from "../src/services/lead-intake";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";
import { fakePlatform } from "./ads-fakes";

/**
 * DIRECT MAIL, THROUGH A FAKE OF LOB
 *
 * A mailing is refused when it would go to everybody or would print a field
 * as nothing or not print each person's own address. Sending it freezes who it
 * goes to, skips somebody with no address with the reason, hands each piece to
 * the printer under its own id as the idempotency key with its own address and
 * QR code, the customer's name escaped and the mailing's tracking number
 * printed, and records what the pieces cost as spend once. A press repeated
 * prints nobody twice; a piece the printer could not be reached for is tried
 * again by the worker. A visit to a piece's own address is counted and
 * recorded once a day as a touch on the mailing for that customer, and the job
 * they then book is credited to the mailing.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("direct-mail:org");
const USER = fixtureId("direct-mail:user");
const ENV = { PUBLIC_URL: "https://ots.test" };

let raw: postgres.Sql;
const db = () => testDb(url!);
const ctx = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const readSecret = async (ref: string) => {
  if (ref !== "LOB_KEY") throw new Error(`No secret named ${ref}`);
  return "test_lob_key_not_real";
};

const fake = fakePlatform();
const deps = { transport: fake.transport, readSecret, env: ENV };
const printed: Record<string, unknown>[] = [];
const refuse = new Set<string>();
let down = false;
fake.on("POST", /^https:\/\/lob\.fake\/v1\/postcards$/, (call) => {
  expect(call.headers["Authorization"]).toBe(`Basic ${Buffer.from("test_lob_key_not_real:").toString("base64")}`);
  if (down) return { status: 503, body: { error: { message: "Service unavailable" } } };
  const body = JSON.parse(call.body) as Record<string, unknown> & { to: { name: string } };
  if (refuse.has(body.to.name)) return { status: 422, body: { error: { message: "address_line1 is undeliverable" } } };
  printed.push({ ...body, idempotencyKey: call.headers["Idempotency-Key"] });
  return { status: 200, body: { id: `psc_${printed.length}`, expected_delivery_date: "2026-10-12" } };
});

const tagged = (name: string, address?: { line1: string; city: string; state: string; postalCode: string }) => customers.create(ctx(), {
  type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: ["fall-mailer"], customFields: {},
  ...(address ? { property: { address: { ...address, country: "US" } } } : {}),
});

const FRONT = "<h1>{{ customer.firstName }}, your furnace</h1>";
const BACK = "<p>Visit {{ mail.url }} or call {{ mail.phone }}. {{ company.name }}</p>";

/**
 * The platforms are local fakes, reached through the connections' own
 * `baseUrl`/`authUrl`. Only a test may point a provider somewhere else
 * (docs/self-hosting/secrets.md), and this file says so for itself.
 */
const allowedBefore = process.env["ALLOW_PROVIDER_BASE_URL"];
afterAll(() => {
  if (allowedBefore === undefined) delete process.env["ALLOW_PROVIDER_BASE_URL"];
  else process.env["ALLOW_PROVIDER_BASE_URL"] = allowedBefore;
});

beforeAll(async () => {
  process.env["ALLOW_PROVIDER_BASE_URL"] = "1";
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Mail Co", slug: "mail-co" });
  await raw`insert into public.location (organization_id, name, address_line1, city, state, postal_code)
            values (${ORG}, 'Office', '1 Main St', 'Austin', 'TX', '78701')`;
});
afterAll(async () => {
  if (!raw) return;
  await raw`update public.integration_connection set status = 'disconnected' where organization_id = ${ORG}`;
  await raw.end();
});

run("a mailing", () => {
  let id = "";
  let trackingId = "";
  let lopezId = "";

  it("is refused for everybody, for a field it cannot fill in, and without each person's own address on it", async () => {
    const base = { name: "Fall tune up", kind: "postcard" as const, size: "4x6" as const, front: FRONT, back: BACK };
    await expect(directMail.create(ctx(), { ...base, audience: [] })).rejects.toThrow(/./);
    await expect(directMail.create(ctx(), { ...base, audience: [{ kind: "tagged_any", tags: ["fall-mailer"] }], back: "<p>{{ customer.nickname }} {{ mail.url }}</p>" }))
      .rejects.toThrow(/customer\.nickname/);
    await expect(directMail.create(ctx(), { ...base, audience: [{ kind: "tagged_any", tags: ["fall-mailer"] }], back: "<p>Call us</p>" }))
      .rejects.toThrow(/mail\.url/);
  });

  it("is drafted with a tracking campaign under Direct mail made for it", async () => {
    lopezId = (await tagged("Lopez & Sons <b>", { line1: "12 Pecan St", city: "Austin", state: "TX", postalCode: "78704" })).id as string;
    await tagged("Ann Bell", { line1: "3 Oak Rd", city: "Austin", state: "TX", postalCode: "78745" });
    await tagged("No Address Co");
    const made = await directMail.create(ctx("mail-create"), {
      name: "Fall tune up", kind: "postcard", size: "4x6", audience: [{ kind: "tagged_any", tags: ["fall-mailer"] }],
      front: FRONT, back: BACK, pricePerPiece: "0.72", landingHeadline: "Your fall tune up",
    });
    id = made.id;
    const got = await directMail.get(ctx(), { id });
    trackingId = got.acquisitionCampaignId;
    const [channel] = await raw<{ source_key: string }[]>`
      select ch.source_key from public.acquisition_campaign ac join public.marketing_channel ch on ch.id = ac.channel_id where ac.id = ${trackingId}`;
    expect(channel!.source_key).toBe("direct_mail");
    await raw`insert into public.phone_number (organization_id, e164, purpose, acquisition_campaign_id) values (${ORG}, '+15125550199', 'tracking', ${trackingId})`;
  });

  it("previews who it goes to, what it costs and how the first card reads, escaped", async () => {
    const preview = await directMail.preview(ctx(), { id });
    expect(preview).toMatchObject({ selected: 3, postable: 2, noAddress: 1, estimatedCost: "1.4400", trackingPhone: "(512) 555-0199" });
    expect(preview.sentence).toContain("fall-mailer");
    expect(preview.front).toBe("<h1>Ann, your furnace</h1>");
  });

  it("refuses to send without a mail house", async () => {
    await expect(directMail.send(ctx(), { id }, deps)).rejects.toThrow(/Connect a mail house/);
  });

  it("sends each piece once, under its own id, with its own address and the tracking number, and records the cost once", async () => {
    await leadIntake.connect(ctx(), { provider: "lob", credentialRef: "LOB_KEY", settings: { baseUrl: "https://lob.fake" } });
    const report = await directMail.send(ctx("mail-send-1"), { id }, deps);
    expect(report).toMatchObject({ state: "sent", pieces: 3, sent: 2, skipped: 1, pending: 0 });
    expect(printed).toHaveLength(2);

    const pieces = await directMail.pieces(ctx(), { id });
    const lopez = pieces.find((p) => p.customerId === lopezId)!;
    const card = printed.find((p) => p["idempotencyKey"] === lopez.id)!;
    expect(card).toMatchObject({
      size: "4x6", use_type: "marketing",
      to: { name: "Lopez & Sons <b>", address_line1: "12 Pecan St", address_zip: "78704" },
      from: { address_line1: "1 Main St", address_city: "Austin" },
      qr_code: { redirect_url: `https://ots.test/m/${lopez.code}` },
    });
    expect(card["front"]).toBe("<h1>Lopez, your furnace</h1>");
    expect(card["back"]).toBe(`<p>Visit https://ots.test/m/${lopez.code} or call (512) 555-0199. Mail Co</p>`);
    expect(pieces.find((p) => p.name === "No Address Co")).toMatchObject({ status: "skipped", reason: expect.stringContaining("No address") });

    /** Pressed again: nothing printed twice, and the cost is the same one row. */
    await directMail.send(ctx("mail-send-2"), { id }, deps);
    expect(printed).toHaveLength(2);
    const spend = await raw<{ amount: string; acquisition_campaign_id: string; source: string }[]>`
      select amount, acquisition_campaign_id, source from public.ad_spend where organization_id = ${ORG} and deleted_at is null`;
    expect(spend).toEqual([{ amount: "1.4400", acquisition_campaign_id: trackingId, source: "direct_mail" }]);
  });

  it("counts a visit to a piece's own address and credits the job the customer then books to the mailing", async () => {
    const lopez = (await directMail.pieces(ctx(), { id })).find((p) => p.customerId === lopezId)!;
    expect(await directMail.visit(db(), { code: "notacode" })).toBeNull();
    const page = await directMail.visit(db(), { code: lopez.code }, deps);
    expect(page).toMatchObject({ companyName: "Mail Co", firstName: "Lopez", headline: "Your fall tune up", phone: "(512) 555-0199" });
    expect(page!.bookingPath).toContain("/book/mail-co?");
    await directMail.visit(db(), { code: lopez.code.toUpperCase() }, deps);

    const after = (await directMail.pieces(ctx(), { id })).find((p) => p.customerId === lopezId)!;
    expect(after.visits).toBe(2);
    const touches = await raw<{ source: string; acquisition_campaign_id: string }[]>`
      select source, acquisition_campaign_id from public.marketing_touch where customer_id = ${lopezId}`;
    expect(touches).toEqual([{ source: "direct_mail", acquisition_campaign_id: trackingId }]);

    const [property] = await raw<{ id: string }[]>`select property_id as id from public.customer_property where customer_id = ${lopezId}`;
    const job = await jobs.create(ctx(), { customerId: lopezId, propertyId: property!.id, summary: "Tune up", tags: [], customFields: {} });
    const [credited] = await raw<{ acquisition_campaign_id: string }[]>`select acquisition_campaign_id from public.job where id = ${job.id as string}`;
    expect(credited!.acquisition_campaign_id).toBe(trackingId);
    const results = (await directMail.get(ctx(), { id })).results;
    expect(results).toMatchObject({ visited: 1, visits: 2, jobs: 1, spend: "1.4400" });
  });
});

run("a mailing the printer refuses or cannot be reached for", () => {
  it("keeps the printer's words on a refused piece, and the worker sends a piece it could not reach later", async () => {
    await tagged("Cara Refused", { line1: "9 Bad Rd", city: "Austin", state: "TX", postalCode: "78702" });
    await tagged("Dev Later", { line1: "5 Elm St", city: "Austin", state: "TX", postalCode: "78703" });
    const { id } = await directMail.create(ctx(), {
      name: "Winter check", kind: "postcard", audience: [{ kind: "postal_code_in", codes: ["78702", "78703"] }],
      front: FRONT, back: BACK,
    });
    refuse.add("Cara Refused");
    down = true;
    const first = await directMail.send(ctx("mail-send-winter"), { id }, deps);
    expect(first).toMatchObject({ state: "sending", sent: 0, failed: 2, refused: 0 });
    down = false;
    const before = printed.length;
    await directMail.mailPass(db(), { deps });
    expect(printed.length).toBe(before + 1);
    const pieces = await directMail.pieces(ctx(), { id });
    expect(pieces.map((p) => [p.name, p.status]).sort()).toEqual([["Cara Refused", "refused"], ["Dev Later", "sent"]]);
    expect(pieces.find((p) => p.name === "Cara Refused")!.reason).toContain("undeliverable");
    expect((await directMail.get(ctx(), { id })).state).toBe("sent");
  });
});
