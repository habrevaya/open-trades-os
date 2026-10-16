import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * DRAIN CALL CONVERSION, FROM WHAT THE PLUMBING PACK MARKS
 *
 * "Drain jobs that produced a camera inspection, a lining or an excavation,
 * divided by all drain jobs. Excludes repeat visits on the same line within
 * thirty days." The plumbing pack marks its drain call and the three items;
 * the figure reads the marks against the codes the company was seeded with.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-drain:org");
const USER = fixtureId("kpi-drain:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
const places = new Map<string, string>();
const units = new Map<string, string>();
const types = new Map<string, string>();
const versions = new Map<string, string>();
let seq = 0;

async function place(name: string): Promise<string> {
  const found = places.get(name);
  if (found) return found;
  const [row] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${name}, 'Austin', 'TX', '78704') returning id`;
  places.set(name, row!.id);
  return row!.id;
}

/** A job of a type, finished at two in the afternoon on `day`, with lines of these price book codes. */
async function job(name: string, opts: {
  type?: string; day?: string; at?: string; unit?: string; parent?: string; status?: string; lines?: string[];
} = {}): Promise<string> {
  seq += 1;
  const day = opts.day ?? "2026-06-20";
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary,
                            completed_at, equipment_id, parent_job_id)
    values (${ORG}, ${seq}, ${customerId}, ${await place(opts.at ?? `${name} St`)}, ${types.get(opts.type ?? "drain")!},
            ${opts.status ?? "completed"}::job_status, ${name},
            ${opts.status === "cancelled" ? null : raw.unsafe(`('${day} 14:00'::timestamp at time zone '${ZONE}')`)},
            ${opts.unit ? units.get(opts.unit)! : null}, ${opts.parent ?? null})
    returning id`;
  for (const code of opts.lines ?? []) {
    await raw`
      insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, price_book_item_version_id)
      values (${ORG}, ${row!.id}, 'labor', ${code}, 1, 100, ${versions.get(code)!})`;
  }
  return row!.id;
}

/** An approved estimate on a job, the chosen option carrying `chosen` and another carrying `other`. */
async function approved(jobId: string, chosen: string[], other: string[] = []): Promise<void> {
  seq += 1;
  const [estimate] = await raw<{ id: string }[]>`
    insert into public.estimate (organization_id, number, customer_id, property_id, job_id, status, title, currency, decided_at)
    select ${ORG}, ${seq}, ${customerId}, property_id, id, 'approved', 'Sewer', 'USD', now() from public.job where id = ${jobId}
    returning id`;
  const option = async (name: string, codes: string[]) => {
    const [row] = await raw<{ id: string }[]>`
      insert into public.estimate_option (organization_id, estimate_id, name) values (${ORG}, ${estimate!.id}, ${name}) returning id`;
    for (const code of codes) {
      await raw`
        insert into public.estimate_line (organization_id, option_id, name, price_book_item_version_id)
        values (${ORG}, ${row!.id}, ${code}, ${versions.get(code)!})`;
    }
    return row!.id;
  };
  const picked = await option("Chosen", chosen);
  await option("Not chosen", other);
  await raw`update public.estimate set selected_option_id = ${picked} where id = ${estimate!.id}`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  for (const map of [places, units, types, versions]) map.clear();
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Drain Plumbing", slug: "kpi-drain-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'plumbing' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Clog Family', 0) returning id`;
  customerId = customer!.id;
  for (const code of ["drain", "repair"]) {
    const [row] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name, code, revenue_class) values (${ORG}, ${code}, ${code}, 'service') returning id`;
    types.set(code, row!.id);
  }
  for (const code of ["CAMERA-INSPECT", "SEWER-LINER-FT", "SEWER-SPOT", "DRAIN-MAIN"]) {
    const [item] = await raw<{ id: string }[]>`
      insert into public.price_book_item (organization_id, code, kind) values (${ORG}, ${code}, 'service') returning id`;
    const [version] = await raw<{ id: string }[]>`
      insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
      values (${ORG}, ${item!.id}, 1, ${code}, '300', now() - interval '400 days') returning id`;
    versions.set(code, version!.id);
  }
  for (const [tag, at] of [["A", "3 Lateral Ln"], ["B", "3 Lateral Ln"]] as const) {
    const [row] = await raw<{ id: string }[]>`
      insert into public.equipment (organization_id, property_id, tag, category) values (${ORG}, ${await place(at)}, ${tag}, 'Sewer lateral')
      returning id`;
    units.set(tag, row!.id);
  }
});

/**
 * The month, by hand. Each job was finished on June 20th unless it says so.
 *
 *   D1   a camera inspection on the job                                  converted
 *   D2   nothing                                                          not converted
 *   D3   a main line clearing only                                        not converted
 *   D4   lining signed for on the chosen option                           converted
 *   D5   an excavation on the option the customer did not choose          not converted
 *   D6   an excavation on a job raised from it                            converted
 *   D7   at 7 Repeat Rd on the 5th, nothing                               not converted
 *   D8   at 7 Repeat Rd on the 15th, a camera                             a return, left out and counted beside
 *   D9   lateral A at 3 Lateral Ln on the 3rd                             not converted
 *   D10  lateral B there on the 10th, a camera                            converted: another line
 *   D11  a camera, finished in July                                       another month
 *   D12  a repair job with a camera                                       not a drain call
 *   D13  at 9 Again Ave on May 1st                                        another month
 *   D14  at 9 Again Ave on the 12th, a camera                             converted: more than thirty days on
 *   D15  a camera on a job raised from it that was cancelled              not converted
 *
 *   Converted: D1 D4 D6 D10 D14 = 5. Calls: D1-D7, D9, D10, D14, D15 = 11.   5 / 11 = 45.5%
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.D1 = await job("D1", { lines: ["CAMERA-INSPECT"] });
  ids.D2 = await job("D2");
  ids.D3 = await job("D3", { lines: ["DRAIN-MAIN"] });
  ids.D4 = await job("D4"); await approved(ids.D4, ["SEWER-LINER-FT"]);
  ids.D5 = await job("D5"); await approved(ids.D5, ["DRAIN-MAIN"], ["SEWER-SPOT"]);
  ids.D6 = await job("D6");
  await job("D6 dig", { type: "repair", parent: ids.D6, day: "2026-07-08", lines: ["SEWER-SPOT"] });
  ids.D7 = await job("D7", { at: "7 Repeat Rd", day: "2026-06-05" });
  ids.D8 = await job("D8", { at: "7 Repeat Rd", day: "2026-06-15", lines: ["CAMERA-INSPECT"] });
  ids.D9 = await job("D9", { at: "3 Lateral Ln", unit: "A", day: "2026-06-03" });
  ids.D10 = await job("D10", { at: "3 Lateral Ln", unit: "B", day: "2026-06-10", lines: ["CAMERA-INSPECT"] });
  ids.D11 = await job("D11", { day: "2026-07-02", lines: ["CAMERA-INSPECT"] });
  ids.D12 = await job("D12", { type: "repair", lines: ["CAMERA-INSPECT"] });
  ids.D13 = await job("D13", { at: "9 Again Ave", day: "2026-05-01" });
  ids.D14 = await job("D14", { at: "9 Again Ave", day: "2026-06-12", lines: ["CAMERA-INSPECT"] });
  ids.D15 = await job("D15");
  await job("D15 camera", { type: "repair", parent: ids.D15, status: "cancelled", lines: ["CAMERA-INSPECT"] });
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "drain_conversion")!;

run("drain call conversion", () => {
  it("counts drain calls that produced a camera, a lining or an excavation, returns to the same line left out", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["5", "11", "45.5"]);
    expect(kpi.besides).toEqual([expect.objectContaining({ key: "excluded", count: "1" })]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const drilled = async (half: "numerator" | "denominator" | "excluded") =>
      (await kpis.drill(owner(), { key: "drain_conversion", half, ...WINDOW })).records.map((r) => name(r.id)).sort();
    expect(await drilled("numerator")).toEqual(["D1", "D10", "D14", "D4", "D6"]);
    expect(await drilled("denominator")).toEqual(["D1", "D10", "D14", "D15", "D2", "D3", "D4", "D5", "D6", "D7", "D9"]);
    expect(await drilled("excluded")).toEqual(["D8"]);
  });

  it("puts the same jobs through core's rule and gets the same answer", async () => {
    const ids = await month();
    const jobs = await raw<{ id: string; code: string; property_id: string; equipment_id: string | null; completed_at: Date | null }[]>`
      select j.id, jt.code, j.property_id, j.equipment_id, j.completed_at
      from public.job j join public.job_type jt on jt.id = j.job_type_id where j.organization_id = ${ORG}`;
    const drains = jobs.filter((j) => j.code === "drain" && j.completed_at !== null);
    /** Which produced an upsell, as worked out by hand above: core is held to the halves, the SQL to the records. */
    const produced = new Set([ids.D1, ids.D4, ids.D6, ids.D8, ids.D10, ids.D11, ids.D14]);
    const counts = { converted: 0, not_converted: 0, repeat: 0 };
    for (const job of drains) {
      const day = job.completed_at!.toLocaleDateString("en-CA", { timeZone: ZONE });
      if (day < WINDOW.from || day > WINDOW.to) continue;
      counts[reporting.drainCallOf({
        completedAt: job.completed_at!, equipmentId: job.equipment_id,
        others: drains.filter((o) => o.id !== job.id && o.property_id === job.property_id)
          .map((o) => ({ completedAt: o.completed_at!, equipmentId: o.equipment_id })),
        producedUpsell: produced.has(job.id),
      })] += 1;
    }
    const kpi = await figure();
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([counts.converted, counts.converted + counts.not_converted]);
    expect(Number(kpi.besides![0]!.count)).toBe(counts.repeat);
  });

  it("reads the drain call and the three upsells the plumbing pack marks", () => {
    const pack = packById("plumbing")!;
    expect(pack.jobTypes.filter((t) => (t.marks ?? []).includes("drain")).map((t) => t.code)).toEqual(["drain"]);
    expect(pack.priceBook.filter((i) => (i.marks ?? []).includes("drain_upsell")).map((i) => i.code).sort())
      .toEqual(["CAMERA-INSPECT", "SEWER-LINER-FT", "SEWER-SPOT"]);
  });
});
