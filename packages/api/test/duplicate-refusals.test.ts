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
  /** A second burden or overhead rate for one component on one day: "which rate applied" would have two answers. */
  costing_rate_day_idx: { file: "costing.ts", how: "check", says: "already has a rate from" },
  /** A journal reversed twice, which would take the same money back twice. */
  journal_entry_reverses_idx: { file: "journals.ts", how: "check", says: "was already reversed by journal" },
  /* ---- caught by the index's own name, through `refusingDuplicate` ---- */
  rentable_asset_identifier_idx: { file: "rentals.ts", how: "catch" },
  company_asset_identifier_idx: { file: "assets.ts", how: "catch" },
  report_name_idx: { file: "reports.ts", how: "catch" },
  delivery_schedule_statements_idx: { file: "delivery-schedules.ts", how: "catch" },
  dashboard_name_idx: { file: "dashboards.ts", how: "catch" },
  agreement_plan_code_idx: { file: "agreements.ts", how: "catch" },
  /** A second press of "Turn on" for a recommended automation already installed. */
  workflow_template_idx: { file: "workflows.ts", how: "catch" },
  /** A customer asking twice about one visit before the office has answered. */
  visit_change_request_pending_idx: { file: "visit-changes.ts", how: "catch" },
  vendor_name_idx: { file: "inventory.ts", how: "catch" },
  /** A vendor's part number typed onto a second item, or a catalogue naming it twice. */
  vendor_item_part_number_idx: { file: "vendor-catalogue.ts", how: "catch" },
  role_name_idx: { file: "roles.ts", how: "catch" },
  /** A technician added twice to one toolbox talk's sign in sheet. */
  safety_meeting_attendee_person_idx: {
    file: "safety.ts", how: "check", says: "is already on the list for this talk",
  },
  /** Two shelves with one name under one parent, typed into the category manager. */
  price_book_category_name_idx: { file: "price-categories.ts", how: "catch" },
  marketing_campaign_utm_idx: { file: "campaigns.ts", how: "catch" },
  marketing_channel_name_idx: { file: "acquisition.ts", how: "catch" },
  acquisition_campaign_name_idx: { file: "acquisition.ts", how: "catch" },
  acquisition_campaign_utm_idx: { file: "acquisition.ts", how: "catch" },
  organization_slug_idx: { file: "organizations.ts", how: "catch" },
  organization_external_ref_idx: { file: "operator.ts", how: "catch" },
  user_email_idx: { file: "operator.ts", how: "catch" },
  /** A second kind of record defined under a key the company already uses. */
  custom_object_type_key_idx: { file: "custom-objects.ts", how: "catch" },
  /** Two proposal layouts with one name, the default chosen twice, or two layouts for one job type. */
  proposal_template_name_idx: { file: "proposal-templates.ts", how: "catch" },
  proposal_template_job_type_idx: { file: "proposal-templates.ts", how: "catch" },
  proposal_template_default_idx: { file: "proposal-templates.ts", how: "catch" },

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
  /** A second claim filed on the same third party invoice. */
  coverage_claim_invoice_idx: {
    file: "claims.ts", how: "check", says: "already has a claim",
  },
  /** A second approval step given a number already taken. */
  purchase_approval_rule_step_idx: {
    file: "purchase-approvals.ts", how: "check", says: "There is already a step",
  },
  /**
   * A serial number received twice. The row is looked up first and reused for
   * a unit that left and came back; one still in stock is refused by name.
   */
  stock_lot_number_idx: {
    file: "inventory.ts", how: "check", says: "is already in stock at",
  },
  /** The same skill recorded twice for one person while the first is still open. */
  technician_skill_open_idx: {
    file: "people-records.ts", how: "check", says: "already has",
  },
};

/**
 * Indexes nobody types a value into, with the reason each is correctly left to
 * the database. A violation here is a BUG, and has to keep looking like one: a
 * sentence apologising for it would hide a generated number colliding, which is
 * the symptom of something much worse than a typo.
 */
const LEFT_TO_THE_DATABASE: Record<string, string> = {
  journal_entry_number_idx: "Allocated by the numbering service, in its own sequence.",
  financing_application_external_idx: "The lender's own id for an application, written once when the lender opens it. Nobody types it.",
  budget_year_idx: "Made on the first write to a year with on conflict do nothing, so a second write finds it rather than colliding.",
  budget_line_cell_idx: "Written with on conflict do update: setting a month again replaces the figure, which is what the screen means.",
  /* --- numbers and sequences this product generates --- */
  invoice_number_idx: "The invoice number is allocated by the numbering service under a lock.",
  estimate_number_idx: "Allocated by the numbering service.",
  job_number_idx: "Allocated by the numbering service.",
  purchase_order_number_idx: "Allocated by the numbering service.",
  credit_note_number_idx: "Allocated by the numbering service, in its own sequence.",
  price_book_item_version_idx: "The version is the previous one plus one, inside the write.",
  project_phase_sequence_idx: "The sequence is assigned by the service, not chosen.",
  project_draw_sequence_idx: "The sequence is assigned by the service, not chosen.",
  project_change_order_number_idx: "Allocated by the service as the next number under a per project lock.",
  project_application_number_idx: "Allocated by the service as the next number under a per project lock.",
  stock_movement_sequence_idx: "A per-item sequence assigned inside the movement write.",
  domain_event_seq_idx:
    "The event log's own per-organization sequence, allocated inside the append.",
  field_operation_device_seq_idx: "The device's own counter, which the sync protocol orders by.",
  workflow_version_idx: "The next version number, assigned on publish.",
  workflow_step_run_idx: "One row per step of a run, keyed by the run and the step.",
  stock_tracking_item_idx:
    "One tracking mode per item. Setting it reads the row first and updates it in place, so nothing inserts a second.",
  truck_stock_minimum_item_location_idx:
    "One live minimum per item per truck, written with on conflict do update: setting it again replaces it.",
  purchase_order_approval_step_idx:
    "A step of an order is decided once. The service only ever decides the step that is waiting, so a collision is two people deciding the same step in the same instant, and the second is a conflict rather than a duplicate anybody typed.",
  purchase_order_send_token_idx: "The hash of thirty two random bytes minted for an emailed order's printable link.",
  onboarding_item_template_idx:
    "One copy of each checklist line per person. Starting onboarding inserts with on conflict do nothing, so starting again adds only the new lines.",
  employment_record_person_idx:
    "One employment record per person, written with on conflict do update: saving it again replaces it.",
  vendor_item_vendor_item_idx:
    "One link per item per vendor: setting a part number updates the item's existing link to that vendor rather than inserting another.",

  /* --- idempotency keys, where a collision is the point --- */
  ai_usage_idempotency_idx: "An idempotency key: a repeat is meant to collide and be ignored.",
  workflow_run_idem_idx: "An idempotency key for a workflow run.",
  report_delivery_key_idx:
    "The occurrence a report delivery was for. A second attempt colliding is the once-per-period guarantee, inserted with on conflict do nothing.",
  statement_delivery_period_idx:
    "One customer's statement for one month. The monthly run inserts with on conflict do nothing, so a repeat sends nothing.",
  field_operation_client_idx: "The client's own operation id, which makes a retry safe.",
  field_upload_client_idx: "The client's own upload id, which makes a retry safe.",
  push_delivery_event_device_idx:
    "One notice per change per phone. The push pass inserts with on conflict do nothing, so reading an event twice buzzes nobody twice.",
  call_provider_call_idx: "The carrier's call id, so a redelivered webhook is not a second call.",
  answering_phone_person_idx:
    "One number per person per company, written with on conflict do update: saving a person's number again replaces it.",
  conversation_reply_token_idx:
    "A random token the service mints for an email thread's reply address. Nobody types it, and a collision is a 2^-190 event rather than a duplicate somebody entered.",
  dni_session_live_idx:
    "One live lease per pool number. Leasing inserts with on conflict do nothing and the loser "
    + "takes the next free number, so two visitors are never shown one number.",
  referral_reward_referred_idx:
    "One reward per referred customer. The worker claims it with on conflict do nothing, which is "
    + "what makes granting a reward idempotent however many passes look.",
  ad_conversion_send_idx:
    "One send per job, platform and kind. The conversion pass claims it with on conflict do nothing, so a collision is a second worker and is skipped.",
  ad_platform_campaign_idx: "The platform's own campaign id per connection, looked up by the spend pull before it inserts.",
  advertising_consent_live_idx:
    "One live answer per customer. The service locks and supersedes the live row in the same write before it inserts.",
  oauth_authorization_state_idx: "The hash of thirty two random bytes the sign in mints.",
  sealed_credential_connection_idx: "One grant per connection, upserted by the sign in.",
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
  task_template_occurrence_idx:
    "One task per recurring template per company day. The worker inserts with on conflict do "
    + "nothing, so a restarted or doubled worker raises the day's task once.",
  task_escalation_once_idx:
    "One escalation per task per rule, inserted first with on conflict do nothing, so only the "
    + "pass whose insert landed tells anybody.",
  customer_not_duplicate_pair_idx:
    "The ordered pair of two customers somebody said are different people, inserted with on "
    + "conflict do nothing: saying it twice is not news.",
  campaign_recipient_once_idx:
    "One row per address per campaign. The sender writes it; nobody types an address into it.",

  /* --- secrets, where the value is random and a collision is not a user error --- */
  app_token_hash_idx:
    "The hash of a token made from 256 random bits. A collision is not a typo.",
  portal_grant_token_idx:
    "The hash of a customer link made from 256 random bits, never chosen by anybody.",
  oauth_code_hash_idx:
    "The hash of an OAuth authorization code made from 256 random bits and handed through a browser once.",
  oauth_refresh_token_hash_idx:
    "The hash of an OAuth refresh token made from 256 random bits, rotated on every use.",
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
  customer_referral_code_idx:
    "A referral code drawn at random by the service, which retries on a collision. Nobody types one in.",
  web_form_public_key_idx:
    "A hosted form's key made from 72 random bits on save, kept through every edit, never chosen.",
  credential_user_idx: "One credential row per user, written by the signup path.",
  payment_profile_customer_idx:
    "One processor customer per customer per payment connection, made the first time a card is "
    + "saved and inserted with on conflict do nothing, so two first saves racing are one profile.",
  saved_payment_method_external_idx:
    "The processor's own id for a saved card. Recording the same setup twice (a refresh of the page "
    + "the processor returned to) inserts with on conflict do nothing and records the card once.",

  /* --- one row per thing, upserted rather than inserted --- */
  ai_budget_org_idx: "One budget per company, upserted.",
  ai_agent_setting_agent_idx: "One settings row per agent per company, upserted.",
  ai_agent_proposal_open_idx:
    "One open draft per agent per source. Inserted with on conflict do nothing, and the open draft is returned instead.",
  ai_agent_proposal_idempotency_idx: "An idempotency key: a repeat is meant to collide and return the first draft.",
  ai_chat_session_token_idx: "A random token's hash, generated here. A collision is a bug, not a duplicate somebody typed.",
  ai_chat_session_conversation_idx:
    "One chat per conversation. A text conversation's is inserted with on conflict do nothing, and a website chat makes its own conversation.",
  discount_policy_org_idx: "One policy per company, upserted.",
  setup_step_key_idx: "One row per setup step per company, upserted when a step is marked done or reopened.",
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
  technician_position_fix_idx:
    "One row per fix a phone took. A batch resent after a dropped answer is the same fixes, inserted with on conflict do nothing.",
  travel_time_pair_idx: "One cached drive time per pair of points per routing provider, upserted when asked again.",
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
