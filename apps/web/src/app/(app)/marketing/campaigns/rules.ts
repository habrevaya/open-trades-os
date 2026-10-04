import type { campaign as cp } from "@opentradesos/core";
import { field, fields } from "@/lib/actions";

/**
 * The nine rules, as boxes.
 *
 * Listed here rather than generated from `RULE_KINDS`, because each one needs a
 * sentence a contractor recognises and two of them need a number whose units are
 * part of the question ("days since" against "years old"). A generated form would
 * read as nine field names.
 *
 * The test asserts this list covers every kind the union has, so a tenth rule
 * added to core cannot ship without a box here.
 */
export const RULES: {
  kind: cp.AudienceRule["kind"];
  label: string;
  fields?: { name: string; label: string; placeholder: string; numeric?: boolean; wide?: boolean }[];
}[] = [
  {
    kind: "no_job_since", label: "Not served for",
    fields: [{ name: "no_job_since_days", label: "Days since the last job", placeholder: "540", numeric: true }],
  },
  {
    kind: "equipment_older_than", label: "Has equipment older than",
    fields: [
      { name: "equipment_years", label: "Years since install", placeholder: "12", numeric: true },
      { name: "equipment_category", label: "Equipment category", placeholder: "furnace" },
    ],
  },
  {
    kind: "agreement_ending_within", label: "Agreement ending within",
    fields: [{ name: "agreement_days", label: "Days until the agreement ends", placeholder: "30", numeric: true }],
  },
  { kind: "agreement_lapsed", label: "Had an agreement that lapsed" },
  { kind: "no_agreement", label: "Never held an agreement" },
  {
    kind: "postal_code_in", label: "In postcodes",
    fields: [{ name: "postal_codes", label: "Postcodes, comma separated", placeholder: "78704, 78745", wide: true }],
  },
  {
    kind: "tagged_any", label: "Tagged any of",
    fields: [{ name: "tags", label: "Tags, comma separated", placeholder: "vip, commercial", wide: true }],
  },
  { kind: "open_deficiency", label: "Has an open inspection finding" },
  { kind: "served_at_least_once", label: "Has had at least one job completed" },
];

/** A comma separated box, split and trimmed. Empties dropped, not kept as "". */
const listOf = (form: FormData, name: string): string[] =>
  (field(form, name) ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");

/**
 * The audience, read off a form.
 *
 * ONE RULE PER SUBMITTED KIND, and only the kinds that were ticked. The nine
 * rules are a closed set in core, so this does not validate them: it assembles
 * what the boxes say and lets `checkAudience` refuse the rest, which reports ALL
 * the refusals rather than the first. Building a rule the union does not have is
 * a type error here rather than a runtime surprise there.
 *
 * An empty audience is not assembled into "everybody". It is passed through as
 * empty and refused, because that refusal is the most valuable one in the module:
 * no rules means the whole customer list, which is how a company's one registered
 * number gets flagged by a carrier and its domain blocked in an afternoon.
 */
export function audienceFrom(form: FormData): cp.AudienceRule[] {
  const picked = new Set(fields(form, "rule"));
  const rules: cp.AudienceRule[] = [];
  const whole = (name: string, fallback: number) => {
    const raw = field(form, name);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(parsed) ? parsed : fallback;
  };

  if (picked.has("no_job_since")) {
    rules.push({ kind: "no_job_since", days: whole("no_job_since_days", 0) });
  }
  if (picked.has("equipment_older_than")) {
    const category = field(form, "equipment_category");
    rules.push({
      kind: "equipment_older_than",
      years: whole("equipment_years", 0),
      ...(category ? { category } : {}),
    });
  }
  if (picked.has("agreement_ending_within")) {
    rules.push({ kind: "agreement_ending_within", days: whole("agreement_days", 0) });
  }
  if (picked.has("agreement_lapsed")) rules.push({ kind: "agreement_lapsed" });
  if (picked.has("no_agreement")) rules.push({ kind: "no_agreement" });
  if (picked.has("postal_code_in")) {
    rules.push({ kind: "postal_code_in", codes: listOf(form, "postal_codes") });
  }
  if (picked.has("tagged_any")) {
    rules.push({ kind: "tagged_any", tags: listOf(form, "tags") });
  }
  if (picked.has("open_deficiency")) rules.push({ kind: "open_deficiency" });
  if (picked.has("served_at_least_once")) rules.push({ kind: "served_at_least_once" });
  return rules;
}
