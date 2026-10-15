import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as fieldOps from "../src/services/field";
import * as serviceReports from "../src/services/service-reports";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * APPLICATION RECORD COMPLETENESS, AND THE LIST IT WAITED ON
 *
 * Pest control's "completed visits where every regulated field required by
 * the operator's configuration was captured, divided by completed visits.
 * EXCLUDES visits recorded with a no product applied reason, which have their
 * own required set." A report now keeps the list of fields it was required to
 * capture, frozen from its template when it is written, so last spring's
 * visits are judged against last spring's list and not today's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-records:org");
const USER = fixtureId("kpi-records:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const tech = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let jobTypeId = "";
let seq = 0;

/** What the operator required: three regulated fields and one that is not. */
const REQUIRED = [
  { key: "product_applied", label: "Product applied", kind: "chemical", regulated: true },
  { key: "epa_reg_no", label: "EPA registration number", kind: "chemical", regulated: true },
  { key: "target_pest", label: "Target pest", kind: "select", regulated: true },
  { key: "stations_serviced", label: "Stations serviced", kind: "numeric", regulated: false },
];

/** A completed visit on its own job, finished on `day`. */
async function visit(day = "2026-06-15", revenueClass = "recurring"): Promise<string> {
  seq += 1;
  const [type] = revenueClass === "recurring" ? [{ id: jobTypeId }] : await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, ${`t${seq}`}, ${`rc-${seq}`}, ${revenueClass}::job_revenue_class) returning id`;
  const at = raw.unsafe(`('${day} 11:00'::timestamp at time zone '${ZONE}')`);
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${type!.id}, 'completed', ${`Visit ${seq}`}, ${at}) returning id`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, completed_at)
    values (${ORG}, ${job!.id}, 'completed', ${at}) returning id`;
  return row!.id;
}

/** A report on the visit, required to capture `required` (null: written before the list was kept), with these fields. */
async function report(visitId: string, required: typeof REQUIRED | null, fields: Record<string, string | number | boolean>): Promise<void> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.service_report (organization_id, visit_id, job_id, customer_id, property_id, required_fields, submitted_at)
    select ${ORG}, v.id, v.job_id, ${customerId}, ${propertyId}, ${required === null ? null : raw.json(required)}, now()
    from public.visit v where v.id = ${visitId} returning id`;
  for (const [key, value] of Object.entries(fields)) {
    await raw`
      insert into public.service_report_field (organization_id, report_id, property_id, key, label, kind,
                                               value_text, value_numeric, value_boolean, product_name)
      values (${ORG}, ${row!.id}, ${propertyId}, ${key}, ${key}, 'text',
              ${typeof value === "string" ? value : null}, ${typeof value === "number" ? String(value) : null},
              ${typeof value === "boolean" ? value : null}, null)`;
  }
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Records Co", slug: "kpi-records-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'pest-control' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '7 Pine', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, 'Quarterly', 'rc-q', 'recurring') returning id`;
  jobTypeId = type!.id;
});

const ALL = { product_applied: "Termidor SC", epa_reg_no: "7969-210", target_pest: "Ants" };

/**
 * The month, by hand.
 *
 *   V1  every regulated field captured                                         complete
 *   V2  the EPA number missing                                                  not complete
 *   V3  all regulated captured, the stations count (not regulated) missing     complete
 *   V4  no report at all                                                        not complete
 *   V5  no product applied, with the reason                                     left out, counted beside
 *   V6  written before the list was kept                                        left out, counted beside as unknown
 *   V7  the operator required nothing regulated when it was written             left out, counted beside as unknown
 *   V8  the target pest typed as spaces                                         not complete
 *   V9  internal work                                                           not customer work
 *   V10 finished in July                                                        another month
 *
 *   Complete V1 V3 = 2; counted V1 V2 V3 V4 V8 = 5.   2 / 5 = 40.0%
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.V1 = await visit(); await report(ids.V1, REQUIRED, { ...ALL, stations_serviced: 12 });
  ids.V2 = await visit(); await report(ids.V2, REQUIRED, { product_applied: "Termidor SC", target_pest: "Ants", stations_serviced: 4 });
  ids.V3 = await visit(); await report(ids.V3, REQUIRED, ALL);
  ids.V4 = await visit();
  ids.V5 = await visit(); await report(ids.V5, REQUIRED, { no_product_reason: "No activity found, monitoring only" });
  ids.V6 = await visit(); await report(ids.V6, null, ALL);
  ids.V7 = await visit(); await report(ids.V7, REQUIRED.filter((f) => !f.regulated), { stations_serviced: 3 });
  ids.V8 = await visit(); await report(ids.V8, REQUIRED, { ...ALL, target_pest: "   " });
  ids.V9 = await visit("2026-06-15", "internal"); await report(ids.V9, REQUIRED, {});
  ids.V10 = await visit("2026-07-02"); await report(ids.V10, REQUIRED, {});
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "record_completeness")!;

run("application record completeness", () => {
  it("judges each visit against the list its report was required to capture, and leaves out the no product visits", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["2", "5", "40.0"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "excluded", count: "1" }),
      expect.objectContaining({ key: "unknown", count: "2" }),
    ]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)![0];
    const listed = async (half: "numerator" | "denominator" | "excluded" | "unknown") =>
      (await kpis.drill(owner(), { key: "record_completeness", half, ...WINDOW })).records.map((r) => name(r.id)).sort();
    expect(await listed("numerator")).toEqual(["V1", "V3"]);
    expect(await listed("denominator")).toEqual(["V1", "V2", "V3", "V4", "V8"]);
    expect(await listed("excluded")).toEqual(["V5"]);
    expect(await listed("unknown")).toEqual(["V6", "V7"]);
  });

  it("puts the same visits through core's rule and gets the same answer", async () => {
    await month();
    const visits = await raw<{ id: string; completed_at: Date; revenue_class: string }[]>`
      select v.id, v.completed_at, jt.revenue_class::text
      from public.visit v join public.job j on j.id = v.job_id join public.job_type jt on jt.id = j.job_type_id
      where v.organization_id = ${ORG}`;
    const reports = await raw<{ id: string; visit_id: string; required_fields: typeof REQUIRED | null }[]>`
      select id, visit_id, required_fields from public.service_report where organization_id = ${ORG}`;
    const fields = await raw<{ report_id: string; key: string; value_text: string | null; value_numeric: string | null; value_boolean: boolean | null }[]>`
      select report_id, key, value_text, value_numeric, value_boolean from public.service_report_field where organization_id = ${ORG}`;
    const verdicts = new Map<string, string>();
    for (const v of visits) {
      if (v.revenue_class === "internal") continue;
      const day = v.completed_at.toLocaleDateString("en-CA", { timeZone: ZONE });
      if (day < WINDOW.from || day > WINDOW.to) continue;
      verdicts.set(v.id, reporting.recordCompletenessOf({
        reports: reports.filter((r) => r.visit_id === v.id).map((r) => ({
          required: r.required_fields,
          captured: fields.filter((f) => f.report_id === r.id && (
            f.value_numeric !== null || f.value_boolean !== null || (f.value_text ?? "").trim() !== ""
          )).map((f) => f.key),
        })),
      }));
    }
    const pick = (...verdict: string[]) => [...verdicts].filter(([, v]) => verdict.includes(v)).map(([id]) => id).sort();
    const ids = async (half: "numerator" | "denominator" | "excluded" | "unknown") =>
      (await kpis.drill(owner(), { key: "record_completeness", half, ...WINDOW })).records.map((r) => r.id).sort();
    expect(await ids("numerator")).toEqual(pick("complete"));
    expect(await ids("denominator")).toEqual(pick("complete", "incomplete"));
    expect(await ids("excluded")).toEqual(pick("excluded"));
    expect(await ids("unknown")).toEqual(pick("unknown"));
  });

  it("is nothing rather than nought with no completed visit", async () => {
    expect((await figure()).value).toBeNull();
  });
});

run("the list a report was required to capture", () => {
  it("is frozen from the template when the phone writes the report, and editing the template later does not move it", async () => {
    const [tpl] = await raw<{ id: string }[]>`
      insert into public.service_report_template (organization_id, name, job_type_id, fields)
      values (${ORG}, 'Application record', ${jobTypeId}, ${raw.json([
        { key: "product_applied", label: "Product applied", kind: "chemical", required: true, regulated: true },
        { key: "epa_reg_no", label: "EPA registration number", kind: "chemical", regulated: true },
        { key: "stations_serviced", label: "Stations serviced", kind: "numeric", required: true },
      ])}) returning id`;
    const visitId = await visit();
    const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
    const [technician] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${membership!.id}, 'Ray') returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visitId}, ${technician!.id})`;
    await raw`update public.visit set status = 'working' where id = ${visitId}`;

    const { deviceId } = await fieldOps.register(tech(), { installationId: `install-${crypto.randomUUID()}` });
    const reportId = crypto.randomUUID();
    await fieldOps.sync(tech(), {
      deviceId,
      operations: [{
        clientId: crypto.randomUUID(), sequence: 1, kind: "service_report.set_field", subjectId: reportId,
        occurredAt: new Date().toISOString(),
        payload: { visitId, field: "product_applied", label: "Product applied", kind: "chemical", value: "Termidor SC" },
      }],
    });
    const frozen = await serviceReports.get(owner(), { id: reportId });
    expect(frozen.requiredFields).toEqual([
      { key: "product_applied", label: "Product applied", kind: "chemical", regulated: true },
      { key: "stations_serviced", label: "Stations serviced", kind: "numeric", regulated: false },
    ]);

    /** The operator now requires the EPA number too. The report keeps what it was asked. */
    await serviceReports.updateTemplate(owner(), {
      id: tpl!.id,
      fields: [
        { key: "product_applied", label: "Product applied", kind: "chemical", required: true, regulated: true },
        { key: "epa_reg_no", label: "EPA registration number", kind: "chemical", required: true, regulated: true },
        { key: "stations_serviced", label: "Stations serviced", kind: "numeric", required: true },
      ],
    });
    expect((await serviceReports.get(owner(), { id: reportId })).requiredFields).toHaveLength(2);
    /** And an edit keeps which fields are regulated, which it used to drop. */
    const [template] = await serviceReports.listTemplates(owner());
    expect(template!.fields.filter((f) => f.regulated).map((f) => f.key)).toEqual(["product_applied", "epa_reg_no"]);
  });
});
