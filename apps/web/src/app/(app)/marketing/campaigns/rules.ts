import type { campaign as cp } from "@opentradesos/core";

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
