import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A DUPLICATE SOMEBODY TYPED IS A REFUSAL, AND EVERY UNIQUE INDEX HAS TO SAY
 * WHICH KIND IT IS
 *
 * The defect this file exists for, stated once:
 *
 *   `rentable_asset_identifier_idx` enforced one container number per company.
 *   The service relied on it and nothing turned Postgres's 23505 into a refusal.
 *   A dispatcher registering a can on a number already in the yard got a
 *   server-side exception and a page that would not load.
 *
 * It was never one bug. The same held for the van register's plate, a saved
 * report's name, a dashboard's name, an agreement plan's code, a vendor's name, a
 * custom role's name, a crew's membership and a campaign's UTM tag. Eight of
 * them, several reachable from screens that shipped.
 *
 * The reasoning already existed in exactly one place. `people.ts` pre-checks a
 * certification code with a comment saying "the index reports a duplicate as a
 * message about `certification_type_code_idx` and the person reading it is an
 * office manager typing in a licence". Nobody generalised it, and nothing made
 * the next unique index answer the same question.
 *
 * WHAT THIS CHECKS. Every `uniqueIndex` in the schema is in exactly one of two
 * lists: refused in words, or left to the database with a reason. A new one
 * fails this test until somebody decides which it is, and a refusal cannot be
 * deleted without the test noticing, because each entry names the file and the
 * text that has to be there.
 *
 * It is static rather than an integration test on purpose. Seventy eight
 * duplicate writes across thirty services would be slow, would need a fixture
 * each, and would still only prove the ones somebody remembered to write. The
 * integration tests for the eight that were wrong live beside their own
 * services; this is the census that says nothing is unaccounted for.
 */
const SCHEMA = join(import.meta.dirname, "../../db/src/schema");
const SERVICES = join(import.meta.dirname, "../src/services");

/** Every `uniqueIndex("name")` the schema declares. */
function declaredIndexes(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(SCHEMA)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(SCHEMA, file), "utf8");
    for (const match of source.matchAll(/uniqueIndex\("([a-z_0-9]+)"\)/g)) found.push(match[1]!);
  }
  return [...new Set(found)].sort();
}

/**
 * How a collision on this index reaches the person who caused it.
 *
 * `catch` means `refusingDuplicate` names the index, so the index's own name has
 * to appear in that service file. `check` means the service selects first and
 * refuses, so a fragment of the sentence it raises has to appear instead. Either
 * way the test reads the service and fails if the refusal has gone.
 */
type Refused =
  | { file: string; how: "catch" }
  | { file: string; how: "check"; says: string };

const REFUSED: Record<string, Refused> = {
  /* ---- caught by the index's own name, through `refusingDuplicate` ---- */
  rentable_asset_identifier_idx: { file: "rentals.ts", how: "catch" },
  company_asset_identifier_idx: { file: "assets.ts", how: "catch" },
  report_name_idx: { file: "reports.ts", how: "catch" },
  dashboard_name_idx: { file: "dashboards.ts", how: "catch" },
  agreement_plan_code_idx: { file: "agreements.ts", how: "catch" },
  vendor_name_idx: { file: "inventory.ts", how: "catch" },
  role_name_idx: { file: "roles.ts", how: "catch" },
  marketing_campaign_utm_idx: { file: "campaigns.ts", how: "catch" },
  organization_slug_idx: { file: "organizations.ts", how: "catch" },
  organization_external_ref_idx: { file: "operator.ts", how: "catch" },
  user_email_idx: { file: "operator.ts", how: "catch" },

  /* ---- selected first and refused in the service's own words ---- */
  certification_type_code_idx: {
    file: "people.ts", how: "check", says: "already has a certification with the code",
  },
  person_certification_reference_idx: {
    file: "people.ts", how: "check", says: "already holds",
  },
  price_book_item_code_idx: {
    file: "pricebook.ts", how: "check", says: "already exists",
  },
  message_template_code_idx: {
    file: "message-templates.ts", how: "check", says: "is already a template here",
  },
  custom_field_definition_key_idx: {
    file: "custom-fields.ts", how: "check", says: "is already defined on",
  },
  pay_period_start_idx: {
    file: "payroll.ts", how: "check", says: "overlaps",
  },
  pay_period_close_live_idx: {
    file: "payroll.ts", how: "check", says: "overlaps",
  },
  crew_member_uniq_idx: {
    file: "crews.ts", how: "check", says: "same technician on the crew twice",
  },
};

/**
 * Indexes nobody types a value into, with the reason each is correctly left to
 * the database. A violation here is a BUG, and has to keep looking like one: a
 * sentence apologising for it would hide a generated number colliding, which is
 * the symptom of something much worse than a typo.
 */
const LEFT_TO_THE_DATABASE: Record<string, string> = {
  /* --- numbers and sequences this product generates --- */
  invoice_number_idx: "The invoice number is allocated by the numbering service under a lock.",
  estimate_number_idx: "Allocated by the numbering service.",
  job_number_idx: "Allocated by the numbering service.",
  purchase_order_number_idx: "Allocated by the numbering service.",
  credit_note_number_idx: "Allocated by the numbering service, in its own sequence.",
  price_book_item_version_idx: "The version is the previous one plus one, inside the write.",
  project_phase_sequence_idx: "The sequence is assigned by the service, not chosen.",
  project_draw_sequence_idx: "The sequence is assigned by the service, not chosen.",
  stock_movement_sequence_idx: "A per-item sequence assigned inside the movement write.",
  domain_event_seq_idx:
    "The event log's own per-organization sequence, allocated inside the append.",
  field_operation_device_seq_idx: "The device's own counter, which the sync protocol orders by.",
  workflow_version_idx: "The next version number, assigned on publish.",
  workflow_step_run_idx: "One row per step of a run, keyed by the run and the step.",

  /* --- idempotency keys, where a collision is the point --- */
  ai_usage_idempotency_idx: "An idempotency key: a repeat is meant to collide and be ignored.",
  workflow_run_idem_idx: "An idempotency key for a workflow run.",
  field_operation_client_idx: "The client's own operation id, which makes a retry safe.",
  field_upload_client_idx: "The client's own upload id, which makes a retry safe.",
  call_provider_call_idx: "The carrier's call id, so a redelivered webhook is not a second call.",
  review_external_idx: "The platform's own review id, so a re-poll is not a second review.",
  lead_offer_external_idx: "The marketplace's own offer id.",
  external_work_order_uniq_idx:
    "Their work order id. `receive` is idempotent on it by design, so a second delivery updates "
    + "rather than inserts.",
  ad_spend_uniq_idx: "A row per source, campaign and day, upserted from a CSV re-import.",
  commission_event_invoice_idx: "One commission per plan per invoice, derived from the payment.",
  commission_reversal_cause_idx: "One reversal per cause, derived from the refund.",
  review_request_job_idx: "One request per job, which is what stops a second ask.",
  task_automation_idx: "One task per automation run, which is what makes the rule idempotent.",
  campaign_recipient_once_idx:
    "One row per address per campaign. The sender writes it; nobody types an address into it.",

  /* --- secrets, where the value is random and a collision is not a user error --- */
  app_token_hash_idx:
    "The hash of a token made from 256 random bits. A collision is not a typo.",
  portal_grant_token_idx:
    "The hash of a customer link made from 256 random bits, never chosen by anybody.",
  calendar_feed_token_idx:
    "The hash of a feed URL made from 256 random bits, handed to a phone rather than typed.",
  lead_source_connector_token_idx:
    "The hash of a webhook token made from 256 random bits and shown once, on creation.",
  unsubscribe_link_token_idx:
    "The hash of a one-click unsubscribe link made from 256 random bits, minted per send.",
  session_token_idx:
    "The hash of a session cookie made from 256 random bits by the sign-in path.",
  setup_token_token_idx:
    "The hash of a first-run setup link made from 256 random bits, emailed rather than typed.",
  stored_file_key_idx: "A generated storage key, not a filename somebody chose.",
  credential_user_idx: "One credential row per user, written by the signup path.",

  /* --- one row per thing, upserted rather than inserted --- */
  ai_budget_org_idx: "One budget per company, upserted.",
  discount_policy_org_idx: "One policy per company, upserted.",
  asset_compliance_kind_idx: "One expiry per asset per kind, upserted by `setAssetObligation`.",
  brand_asset_kind_idx:
    "One asset per kind (a logo, a mark, a favicon), replaced rather than added to on upload.",
  integration_connection_uniq_idx: "One connection per provider and capability, upserted.",
  account_mapping_code_idx: "One mapping per account code, upserted.",
  accounting_entity_link_entity_idx: "One link per local record, upserted by the sync.",
  accounting_entity_link_external_idx: "One link per remote record, upserted by the sync.",
  accounting_period_end_idx: "One period per end date, and the close path checks the range first.",
  reorder_policy_item_location_idx: "One policy per item and location, upserted.",
  recording_policy_jurisdiction_idx: "One policy per jurisdiction, upserted.",
  device_installation_idx: "One row per installation of the app, upserted on registration.",
  project_job_job_idx: "One project link per job, which is what stops a job being in two.",
  web_form_slug_idx: "Upserted on the slug, because publishing a form again is an edit.",
  network_grant_uniq_idx:
    "Upserted and left alone, so granting twice is a no-op. That is the right shape for a "
    + "checkbox and the module's own tests require it.",
  suppression_live_purpose_idx: "Upserted: a second unsubscribe for the same purpose is not news.",
  suppression_live_all_idx:
    "Upserted too: a blanket do-not-contact recorded twice is one do-not-contact.",
  overtime_policy_active_idx: "One active policy per company; superseding writes the old one off.",
  review_policy_active_idx: "One active policy per company.",
  review_platform_idx: "One row per platform per company, upserted from settings.",
  membership_org_user_idx:
    "One membership per person per company. The invite path checks whether they are already in, "
    + "and the only other writer is signup, which has just created the company.",
  phone_number_live_idx:
    "A number comes from the carrier's API, not from a box: two rows for one number means the "
    + "provider listed it twice.",
  network_slug_idx:
    "Replayed rather than refused: `operator_create_network` returns the existing network for a "
    + "slug, so creating the same one twice is idempotent by design.",
};

describe("every unique index says how a duplicate reaches the person", () => {
  const declared = declaredIndexes();

  it("accounts for every unique index in the schema, and for nothing else", () => {
    /**
     * Both directions. An index missing from both lists is a decision nobody has
     * made; an entry in a list for an index that no longer exists is a comment
     * describing a constraint that is gone, which reads as a guarantee.
     */
    const accounted = [...Object.keys(REFUSED), ...Object.keys(LEFT_TO_THE_DATABASE)].sort();
    const missing = declared.filter((index) => !accounted.includes(index));
    const stale = accounted.filter((index) => !declared.includes(index));

    expect(missing, "unique indexes nobody has classified").toEqual([]);
    expect(stale, "classified indexes the schema no longer declares").toEqual([]);
  });

  it("puts no index in both lists", () => {
    const both = Object.keys(REFUSED).filter((index) => index in LEFT_TO_THE_DATABASE);
    expect(both).toEqual([]);
  });

  it("finds the refusal in the service that is supposed to raise it", () => {
    /**
     * This is what stops a refusal being quietly deleted. The `catch` entries
     * are checked by the index's own name, which `refusingDuplicate` takes as its
     * first argument; the `check` entries by a fragment of the sentence, because
     * a pre-check mentions no index at all.
     */
    const gone: string[] = [];
    for (const [index, entry] of Object.entries(REFUSED)) {
      const source = readFileSync(join(SERVICES, entry.file), "utf8");
      const needle = entry.how === "catch" ? index : entry.says;
      if (!source.includes(needle)) gone.push(`${index} in ${entry.file}: no "${needle}"`);
    }
    expect(gone).toEqual([]);
  });

  it("gives every left-to-the-database index a reason worth reading", () => {
    /**
     * A reason, not a label. "By design" and "not applicable" are the entries
     * that let the list grow until it means nothing, and this is the only place
     * that can refuse them.
     */
    const thin = Object.entries(LEFT_TO_THE_DATABASE)
      .filter(([, reason]) => reason.length < 30 || /^(by design|n\/a|not applicable)\.?$/i.test(reason))
      .map(([index]) => index);
    expect(thin, "reasons too short to be a reason").toEqual([]);
  });

  it("catches a duplicate by a named index, never by any unique violation", () => {
    /**
     * Catching every 23505 inside a write would turn an unrelated collision, an
     * idempotency key or a generated document number, into a sentence blaming the
     * wrong field. Those are bugs and have to keep looking like bugs, so
     * `refusingDuplicate` takes an index name and the bare helper is never called
     * without a constraint in a service write.
     */
    const helper = readFileSync(join(SERVICES, "duplicates.ts"), "utf8");
    expect(helper).toContain("isUniqueViolation(error, index)");

    for (const file of readdirSync(SERVICES)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(SERVICES, file), "utf8");
      for (const call of source.matchAll(/isUniqueViolation\(([^)]*)\)/g)) {
        const args = call[1]!;
        if (file === "organizations.ts" && args.includes("constraint")) continue;
        if (file === "duplicates.ts") continue;
        expect(args, `${file} catches any unique violation`).toMatch(/,\s*"[a-z_0-9]+"/);
      }
    }
  });
});
