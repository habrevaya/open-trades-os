import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as entitlements from "../src/services/entitlements";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE TRASH BIN TRADE'S RE-CLEAN RATE, FROM WHY A RETURN WAS FREE
 *
 * "Free re-cleans divided by completed stops. Counts only our-fault returns,
 * not bins that were not out." A job's coverage already says why it is free:
 * rework on our own work, our own warranty, or goodwill for a bin that was not
 * out. Checked against a month worked out by hand, with a free return nobody
 * gave a reason for counted beside rather than in.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-redo:org");
const USER = fixtureId("kpi-redo:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let typeId = "";
let number = 0;

/** A job completed on a day in Austin, with one completed visit, and its revenue on the ledger. */
async function cleaned(on: string, opts: { parent?: string; revenue?: string } = {}): Promise<string> {
  number += 1;
  const at = `${on}T16:00:00Z`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, parent_job_id, completed_at)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, ${typeId}, 'completed', ${`Clean ${number}`}, ${opts.parent ?? null}, ${at}::timestamptz)
    returning id`;
  await raw`
    insert into public.visit (organization_id, job_id, sequence, status, completed_at)
    values (${ORG}, ${job!.id}, 1, 'completed', ${at}::timestamptz)`;
  if (opts.revenue) {
    await raw`
      insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction, account_code, currency,
                                       amount, source_type, source_id, job_id)
      select ${ORG}, t.id, ${at}::timestamptz, d.direction, d.code, 'USD', ${opts.revenue}, 'manual', t.id, ${job!.id}
      from (select gen_random_uuid() as id) t,
           (values ('debit'::ledger_direction, '1100'), ('credit'::ledger_direction, '4000')) as d(direction, code)`;
  }
  return job!.id;
}

/** Why it was free, said on the job's page as the office says it. */
const because = (jobId: string, source: "no_charge_callback" | "our_warranty" | "goodwill" | "customer") =>
  entitlements.resolve(owner(), { jobId, source });

const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await raw?.end();
});

beforeEach(async () => {
  if (!url) return;
  number = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Bin Co", slug: "kpi-redo-co" });
  await raw`update public.organization set primary_trade = 'trash-bin-cleaning', timezone = 'America/Chicago' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days) values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '3 Curb Ct', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, 'Bin clean', 'bin', 'route', 'recurring'::job_revenue_class) returning id`;
  typeId = type!.id;
});

run("the re-clean rate", () => {
  it("counts free returns for our own work over completed stops, and says how many free returns have no reason", async () => {
    /**
     * Worked by hand, for June 2026.
     *
     *   six paid cleans                                  6 stops
     *   a return coded rework on our own work            our fault, 1 stop
     *   a return coded our own warranty                  our fault, 1 stop
     *   a return coded goodwill (the bin was not out)    not counted, 1 stop
     *   a return billed to the customer                  not counted, 1 stop
     *   a free return with no reason recorded            not counted, beside, 1 stop
     *   rework on our own work finished on July 1        July's
     *
     * 2 / 11 = 18.2%, with one free return beside it whose fault nobody said.
     */
    const first = await cleaned("2026-06-02", { revenue: "25.0000" });
    for (const day of ["2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08", "2026-06-09"]) {
      await cleaned(day, { revenue: "25.0000" });
    }
    await because(await cleaned("2026-06-10", { parent: first }), "no_charge_callback");
    await because(await cleaned("2026-06-11", { parent: first }), "our_warranty");
    await because(await cleaned("2026-06-12", { parent: first }), "goodwill");
    await because(await cleaned("2026-06-15", { parent: first, revenue: "25.0000" }), "customer");
    const silent = await cleaned("2026-06-16", { parent: first });
    await because(await cleaned("2026-07-01", { parent: first }), "no_charge_callback");

    const card = await kpis.scorecard(owner(), WINDOW);
    const redo = card.computed.find((k) => k.key === "redo_rate")!;
    expect(redo.numerator).toBe("2");
    expect(redo.denominator).toBe("11");
    expect(redo.value).toBe("18.2");
    expect(redo.besides).toEqual([expect.objectContaining({ key: "unknown", count: "1" })]);

    const unknown = await kpis.drill(owner(), { key: "redo_rate", half: "unknown", ...WINDOW });
    expect(unknown.records.map((r) => r.id)).toEqual([silent]);
    expect(unknown.records[0]!.href).toBe(`/jobs/${silent}`);

    /** Saying why it was free takes it off the unknown list and puts it where it belongs. */
    await because(silent, "no_charge_callback");
    const after = (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "redo_rate")!;
    expect(after.numerator).toBe("3");
    expect(after.besides).toEqual([expect.objectContaining({ key: "unknown", count: "0" })]);
  });

  it("is nothing rather than nought over a month with no completed stop", async () => {
    const card = await kpis.scorecard(owner(), WINDOW);
    expect(card.computed.find((k) => k.key === "redo_rate")!.value).toBeNull();
  });
});
