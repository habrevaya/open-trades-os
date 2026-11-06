import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { equipment, customFields, ConflictError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { CustomFieldFilter } from "@/components/CustomFieldFilter";
import { fieldFrom } from "@/lib/field-filter";
import { formatDay } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * EVERY UNIT, AT EVERY ADDRESS
 *
 * The register had a page per address and a page per unit, and nothing that
 * answered "which of our furnaces are over fifteen years old" or "which units
 * still have parts cover". This is `GET /v1/equipment` without an address:
 * filtered by kind, age, warranty and the company's own fields, a page at a
 * time, each unit with where it is and who to ring. The reader sees the units
 * at the addresses whose work they see, as the search box does.
 */

const WARRANTY = [
  { key: "", label: "Any warranty" },
  { key: "covered", label: "Still covered" },
  { key: "lapsed", label: "Run out" },
  { key: "none", label: "None recorded" },
] as const;

const box = "h-9 rounded border border-steel-300 px-2 text-sm";
const PAGE = 50;

type Params = {
  kind?: string; minAge?: string; maxAge?: string; warranty?: string; cursor?: string;
  field?: string | string[]; value?: string | string[]; fieldmatch?: string;
};

/** A whole number of years typed in a box, or nothing. */
const years = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 200 ? n : undefined;
};

export default async function EquipmentListPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "equipment:read")) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
        <PageHeader title="Equipment" />
        <Empty title="Not shown to your role">The equipment register needs the permission that reads equipment.</Empty>
      </div>
    );
  }

  const params = await searchParams;
  const { pairs, match, byField } = fieldFrom(params);
  const warranty = WARRANTY.find((w) => w.key === params.warranty && w.key !== "")?.key as "covered" | "lapsed" | "none" | undefined;
  const filters = {
    ...(params.kind ? { kind: params.kind } : {}),
    ...(years(params.minAge) !== undefined ? { minAgeYears: years(params.minAge) } : {}),
    ...(years(params.maxAge) !== undefined ? { maxAgeYears: years(params.maxAge) } : {}),
    ...(warranty ? { warranty } : {}),
  };
  const [kinds, declared] = await Promise.all([equipment.kinds(ctx), customFields.formFields(ctx, "equipment")]);

  /** A filter the service refuses is said above the list, and the list shown without it. */
  let refusal: string | null = null;
  let fieldRefusal: string | null = null;
  const ask = (withFields: boolean, withFilters: boolean) => equipment.unitList(ctx, {
    ...(withFilters ? filters : {}), ...(withFields ? byField : {}), limit: PAGE,
    ...(params.cursor ? { cursor: params.cursor } : {}),
  });
  let page: Awaited<ReturnType<typeof equipment.unitList>>;
  try {
    page = await ask(true, true);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    try {
      page = await ask(false, true);
      fieldRefusal = error.message;
    } catch (second) {
      if (!(second instanceof ConflictError)) throw second;
      refusal = second.message;
      page = await ask(false, false);
    }
  }

  const keep = {
    ...(params.kind ? { kind: params.kind } : {}),
    ...(params.minAge ? { minAge: params.minAge } : {}),
    ...(params.maxAge ? { maxAge: params.maxAge } : {}),
    ...(warranty ? { warranty } : {}),
  };
  const next = page.nextCursor
    ? `/equipment?${new URLSearchParams([
      ...Object.entries(keep),
      ...pairs.flatMap((p) => [["field", p.key], ["value", p.value]] as [string, string][]),
      ...(match === "any" ? [["fieldmatch", "any"] as [string, string]] : []),
      ["cursor", page.nextCursor],
    ]).toString()}`
    : null;
  const filtered = Object.keys(filters).length > 0 || pairs.length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Equipment" count={page.data.length} />
      <p className="mt-1 text-sm text-ink-500">Every unit at every address you can see. Units taken off a register are left out.</p>

      <form action="/equipment" method="get" className="mt-4 flex flex-wrap items-end gap-3" aria-label="Filter the equipment">
        {pairs.flatMap((p, i) => [
          <input key={`f-${i}`} type="hidden" name="field" value={p.key} />,
          <input key={`v-${i}`} type="hidden" name="value" value={p.value} />,
        ])}
        {match === "any" ? <input type="hidden" name="fieldmatch" value="any" /> : null}
        <label className="text-sm">
          <span className="block text-ink-700">Kind</span>
          <select name="kind" defaultValue={params.kind ?? ""} className={`mt-1 ${box}`}>
            <option value="">Every kind</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">At least, years old</span>
          <input name="minAge" type="number" min={0} max={200} defaultValue={params.minAge ?? ""} className={`mt-1 w-24 ${box}`} />
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">At most, years old</span>
          <input name="maxAge" type="number" min={0} max={200} defaultValue={params.maxAge ?? ""} className={`mt-1 w-24 ${box}`} />
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">Warranty</span>
          <select name="warranty" defaultValue={warranty ?? ""} className={`mt-1 ${box}`}>
            {WARRANTY.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
          Show
        </button>
        {filtered ? <a href="/equipment" className="text-sm underline">Clear all</a> : null}
        <span className="basis-full text-xs text-ink-500">A unit with no install date is left out when you filter by age.</span>
      </form>
      {refusal ? <p role="alert" className="mt-3 text-sm text-red-600">{refusal}</p> : null}
      <CustomFieldFilter action="/equipment" declared={declared} keep={keep} pairs={pairs}
                         refusal={fieldRefusal} noun="units" match={match} anyOf />

      {page.data.length === 0 ? (
        <div className="mt-4">
          <Empty title={filtered ? "No units match" : "No equipment yet"}>
            {filtered ? "Try fewer filters." : "Units are added on an address's page, or by the phone app when a technician records one."}
          </Empty>
        </div>
      ) : (
        <Table label="Equipment" head={<><Th>Unit</Th><Th>Make and model</Th><Th>Serial</Th><Th>Age</Th><Th>Warranty</Th><Th>Address</Th><Th>Customer</Th></>}>
          {page.data.map((u) => (
            <tr key={u.id} className="hover:bg-steel-100">
              <Td>
                <a href={`/equipment/${u.id}`} className="font-medium text-ink-900 hover:underline">{u.category}</a>
                {u.tag ? <span className="ml-1 text-xs text-ink-500">{u.tag}</span> : null}
              </Td>
              <Td className="text-ink-700">{[u.manufacturer, u.model].filter(Boolean).join(" ") || "Not recorded"}</Td>
              <Td className="font-mono text-xs text-ink-700">{u.serialNumber ?? ""}</Td>
              <Td className="tabular-nums text-ink-700">{u.ageYears === null ? "Not known" : `${u.ageYears} ${u.ageYears === 1 ? "year" : "years"}`}</Td>
              <Td>
                {u.warranty.partsCovered || u.warranty.labourCovered ? (
                  <Chip tone="success">
                    {u.warranty.partsCovered && u.warranty.labourCovered ? "Parts and labour" : u.warranty.partsCovered ? "Parts only" : "Labour only"}
                    {u.warranty.soonestExpiry ? ` to ${formatDay(u.warranty.soonestExpiry, user.organizationTimezone)}` : ""}
                  </Chip>
                ) : u.warranty.soonestExpiry ? (
                  <Chip tone="neutral">Ran out {formatDay(u.warranty.soonestExpiry, user.organizationTimezone)}</Chip>
                ) : <span className="text-sm text-ink-500">None recorded</span>}
              </Td>
              <Td><a href={`/properties/${u.propertyId}`} className="text-ink-700 hover:underline">{u.address}</a></Td>
              <Td>{u.customer ? <a href={`/customers/${u.customer.id}`} className="text-ink-700 hover:underline">{u.customer.name}</a> : <span className="text-ink-500">Nobody linked</span>}</Td>
            </tr>
          ))}
        </Table>
      )}
      {next ? (
        <p className="mt-4"><a href={next} className="text-sm font-medium underline">Next {PAGE}</a></p>
      ) : params.cursor ? (
        <p className="mt-4 text-sm text-ink-500">That is the last of them. <a href="/equipment" className="underline">Back to the start</a></p>
      ) : null}
    </div>
  );
}
