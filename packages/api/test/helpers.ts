import postgres from "postgres";
import { createHash } from "node:crypto";
import { createClient, type Database } from "@opentradesos/db";

/**
 * Cleaning up between integration tests.
 *
 * Every delete is SCOPED TO AN ORGANIZATION, and that is not tidiness. An
 * unscoped `delete from price_book_item_version` in one test file was blocked
 * by a foreign key from another file's invoice lines, the beforeAll threw, and
 * vitest reported the whole suite as SKIPPED rather than failed. Forty three
 * tests silently stopped running and the summary still looked green enough to
 * miss.
 *
 * So: scoped deletes, in foreign key order, in one place.
 */
const ORDER = [
  /** A copy's runs point at their destination, so they go first. Nothing else points at any of the three. */
  "backup_run", "backup_destination", "restore_run",
  /**
   * Payroll first. A commission event points at an invoice and a job, an entry
   * points at the event and at a pay period, and an export points at a close.
   * Deleting the children before the invoices below is what keeps a reset from
   * tripping on a foreign key, and the whole block is here rather than beside
   * the timeclock because it is the most child-like thing in the schema.
   */
  /**
   * A tip's share points at the payment it came with, the technician it is
   * for and the pay period that paid it, so it goes before all three.
   */
  "tip_share",
  /** A cash tip a technician kept points at the technician, the job and the visit. */
  "cash_tip",
  "payroll_export", "pay_period_close", "commission_entry", "commission_reversal",
  "commission_event", "commission_plan", "pay_period",
  /**
   * A project's link to its work goes before the job, and the draws before
   * the invoices they became. Nothing points at a project but these, so the
   * project itself follows its own children.
   */
  "project_lien_record", "project_application_line", "project_application",
  "project_change_order_line", "project_change_order",
  "project_draw", "project_job", "project_phase", "project",
  /**
   * A loan application points at the payment its funding became, the invoice
   * or estimate it was for, the customer and the lender's connection, so it
   * goes before all of them. The costing rates, the budget and the journal
   * headers point only at the company, and sit here with the money they are
   * about.
   */
  "financing_application", "costing_rate", "budget_line", "budget", "journal_entry",
  // Money, since it references almost everything.
  "ledger_entry", "deferred_revenue_entry", "payment_allocation", "payment",
  "credit_note_payout", "credit_note_application", "credit_note_line", "credit_note",
  /** An estimate's send points at the estimate, the message it became and the link it carried. */
  "estimate_delivery",
  /** A claim points at the invoice it is about, the job and the payer. */
  "coverage_claim",
  "invoice_delivery", "invoice_line", "invoice",
  "deposit", "estimate_line", "estimate_option", "estimate", "document_signature",
  /** A layout an estimate points at, after the estimates that copied it. */
  "proposal_template",
  "agreement_billing", "agreement_visit", "agreement_term", "agreement", "agreement_plan",
  /**
   * Safety records point at a job, an address and the technicians on them,
   * so they go before all three; a person on a report and a line on a sign in
   * sheet go before the report and the talk they belong to.
   */
  "incident_person", "incident_report", "safety_meeting_attendee", "safety_meeting",
  /** A talk's schedule points at its topic, a crew and a technician; the library goes after it. */
  "safety_talk_schedule", "safety_topic",
  // Then work.
  /**
   * What each ad platform was told about a job, and each customer's answer
   * about their details and advertising. Both point at the job or the
   * customer below.
   */
  "ad_conversion_adjustment", "ad_conversion_send", "advertising_consent",
  /**
   * A mailing's pieces point at the customer and the property they were
   * posted to, so they go before both; the mailing itself before the tracking
   * campaign it is credited to, further down.
   */
  "mail_piece", "mail_campaign",
  "delivery",
  "obligation", "authorization", "external_work_order",
  /**
   * A customer's request to move or cancel a visit points at the visit, the
   * job, the customer and the online booking rules it was checked against,
   * so it goes before all four.
   */
  "visit_change_request",
  /**
   * A company's own records (a permit, an inspection) point at a customer,
   * an address, a job and a unit, so they go before all four.
   */
  "custom_object_record",
  "service_report_field", "service_report", "visit_asset", "visit_assignment",
  "job_line",
  "visit", "entitlement", "job_party", "job",
  /** A card's labour rate points at the job type it is for and at its card, so it goes before both. */
  "rate_card_labour_rate",
  "job_type",
  // Then the things work points at.
  "deficiency", "inspection", "inspection_program",
  "equipment_move", "equipment",
  "customer_not_duplicate",
  /**
   * A referral reward points at the two customers and the first job, so it
   * goes before all three.
   */
  "referral_reward",
  /** A customer's tags, one row each, written by a trigger from the customer's own list. */
  "customer_tag",
  "customer_property", "contact", "property", "customer",
  /**
   * An approval step can be for one vendor, one price book category or one
   * location, so it goes before all three. A decision that copied it points
   * at it with set null and does not hold it up.
   */
  "purchase_approval_rule",
  /** A vendor's number for an item points at both, so it goes before the item and the vendor. */
  "vendor_item",
  "price_change_line", "price_change_batch",
  /** Which item is charged after hours and on a holiday points at the items, so it goes first. */
  "after_hours_rate",
  "price_book_item_version", "price_book_item", "price_book_category",
  "rate_card_line", "rate_card", "contract_site", "service_contract",
  "timeclock_entry", "overtime_policy", "wage_scale",
  /**
   * The discount limit. Nothing points at it: it is matched by organization,
   * never by id, which is why a company can set one before it has quoted
   * anything.
   */
  "discount_policy",
  "technician_position", "push_delivery", "field_upload", "field_operation", "device_snapshot", "device",
  "arrival_notice",
  // Automation. A step run points at a run, a run at a version, a version at
  // a workflow. Events are last because a run references one.
  // Tasks before runs: a task points at the run that raised it.
  // Inventory, in dependency order: movements reference orders and lines,
  // lines reference an order, and a reorder policy references a vendor.
  // A movement points at the serial or lot it moved and the delivery it came
  // on; a delivery's charges, an order's approvals and its sends point at
  // the order; truck minimums point at the item and the truck.
  // A late freight bill and a return to a vendor are named by the movements
  // they made, and point at the delivery, the order and the vendor.
  "stock_movement", "stock_lot", "stock_tracking", "truck_stock_minimum",
  "landed_cost_bill_charge", "landed_cost_bill", "vendor_return",
  "purchase_order_receipt_charge", "purchase_order_receipt",
  "purchase_order_approval_notice",
  "purchase_order_approval", "purchase_order_send",
  "purchase_order_line", "purchase_order", "reorder_policy", "vendor",
  // A dashboard's tiles point at reports by id inside jsonb, which no foreign
  // key enforces, so the order here is for the reader rather than for the
  // database: the thing pointing goes before the thing pointed at.
  /**
   * A delivery points at its schedule, a schedule at a saved report, and a
   * statement delivery at the customer and the message it went as.
   */
  "statement_delivery", "report_delivery", "delivery_schedule",
  "dashboard", "report",
  // The company's own logo and favicon, which are bytes rather than a key.
  "brand_asset",
  /**
   * What the setup wizard remembers: the steps marked done, and each time a
   * trade pack was applied with what it seeded. Nothing points at either.
   */
  "setup_step", "trade_pack_application",
  "task_escalation", "task_checklist_item",
  "task",
  "task_escalation_rule", "task_template",
  "knowledge_note",
  "workflow_step_run", "workflow_run", "workflow_schedule", "workflow_version", "workflow",
  "event_cursor", "domain_event",
  // Communications, in dependency order: a message points at a conversation
  // and a consent row, a call points at a number, a number points at a
  // campaign, a campaign points at a brand.
  /** What the phone assistant did on a call points at the call and the booking request it took. */
  "voice_agent_session",
  "message_attachment", "message", "call", "conversation",
  "suppression", "communication_consent", "message_template",
  // Nothing points at a recording policy: it is matched by jurisdiction
  // string, never by id, which is why a party's jurisdiction can name a
  // place the operator has not declared.
  "recording_policy",
  /** A website visitor's lease on a pool number points at the number. */
  "dni_session",
  "phone_number",
  /**
   * A number points at the menu that answers it; menus and groups point at each other only by id in their options.
   * A waiting line points at the ring group that answers it, and a call at the line it waited in.
   */
  "phone_menu", "call_queue", "ring_group", "answering_phone", "softphone_presence",
  "messaging_campaign", "messaging_brand",
  /**
   * A saved card points at the customer's processor profile and at the sign
   * in that saved it, and a sign in's session is a grant naming the code
   * that opened it, so the cards go first and the codes last.
   */
  /**
   * A charge on file names the agreement it was made under, and an
   * agreement names the card, so the charges go first, then the
   * agreements, then the cards.
   */
  "card_on_file_charge", "payment_agreement",
  "saved_payment_method", "payment_profile",
  "portal_event", "portal_grant", "portal_sign_in",
  "booking_request", "bookable_service", "arrival_window",
  "portal_block", "portal_layout", "service_report_template",
  /**
   * The compliance register, before the attachments and the obligations that
   * point at it. Neither pointer is a foreign key: both are the entity_type
   * and entity_id string pair, so nothing enforces this order and it is here
   * for the reader. A renewal deadline outliving the document it is about is
   * exactly the leftover this list exists to prevent.
   */
  "compliance_document",
  "retention_hold", "retention_purge_run",
  "retention_policy", "regulatory_submission",
  "recurring_schedule", "route_stop", "route", "crew_member", "crew",
  /** A charge found on a haul points at the hire and at the fee it was priced from. */
  "rental_charge",
  "rental", "rentable_asset", "territory", "business_hours", "company_holiday",
  /**
   * The company's own tools, children first. Every one of these cascades
   * from `company_asset`, which cascades from the organization, but a scoped
   * reset deletes rows rather than the tenant, so each needs naming.
   *
   * Not to be confused with `rentable_asset` above, which is a hire unit a
   * customer pays for, or with `equipment`, which is the customer's own.
   */
  "asset_cost", "asset_compliance", "asset_maintenance_plan",
  "asset_meter_reading", "asset_custody", "company_asset",
  /** A lead's messages and the inbox's emails point at the offer; the offer at its connector. */
  "lead_offer_message", "lead_email", "lead_inbox",
  "lead_offer", "lead_source_connector", "sync_run",
  /** What Search Console and Analytics reported, per connection. */
  "search_query_day", "analytics_session_day",
  /**
   * Calendar feeds, before the technician they point at and before the
   * organization. A feed is a credential rather than a record of work, so it
   * sits here with the other integration state rather than beside the
   * visits it shows.
   */
  "calendar_feed",
  /**
   * The accounting bridge, before the connection every one of them
   * cascades from. A period close points at no connection at all, which
   * is deliberate: a filed quarter outlives whichever accounting system
   * the company was using when it filed.
   */
  "accounting_entity_link", "account_mapping", "accounting_period",
  /**
   * The agents' log, drafts, chats and settings first, because a draft points
   * at the usage row it came from. Then model spend, before the connection
   * every row of it cascades from. The
   * budget points at no connection at all, which is deliberate: a company's
   * monthly ceiling outlives whichever vendor's key it was holding when the
   * ceiling was set.
   */
  "ai_agent_activity", "ai_agent_proposal", "ai_chat_session", "ai_agent_setting",
  "ai_usage", "ai_budget",
  /**
   * A sign in in flight, the sealed grant it left and the platform's
   * campaigns, all before the connection each cascades from.
   */
  "oauth_authorization", "sealed_credential", "ad_platform_campaign",
  "integration_connection",
  // An app's tokens, then the app. Both cascade from the organization, but a
  // scoped reset deletes rows rather than the tenant, so they need naming.
  "oauth_refresh_token", "oauth_code",
  "app_token", "connected_app",
  /**
   * Attachments before the files they point at. The key is a string rather
   * than a foreign key, so nothing enforces this order; it is here for the
   * reader, and because a stored file outliving every reference to it is
   * exactly the leftover this list exists to prevent.
   */
  /**
   * Marketing, in dependency order: a submission points at a form and at a
   * touch, a touch points at a customer and a job. Spend points at nothing,
   * which is the whole reason it can be imported before anybody has been
   * matched to it.
   */
  "form_submission", "web_form", "marketing_touch", "ad_spend",
  /**
   * The campaign tables. A recipient points at a campaign and a customer, an
   * unsubscribe link at a campaign, so both go before it. `job.campaign_id`
   * references the campaign too, with ON DELETE SET NULL, and the job is
   * already gone by here.
   */
  "campaign_recipient", "unsubscribe_link", "marketing_campaign",
  /**
   * The company's channels and tracking campaigns, after everything that
   * points at them: touches, spend, calls, numbers, jobs, customers and lead
   * connectors all carry one or both, and a campaign points at its channel.
   */
  "acquisition_campaign", "marketing_channel",
  /**
   * Reviews: a request points at a job and a customer, a review at both
   * plus a technician. The policy and the platform list point at nothing,
   * which is why a company can declare them before it has any reviews.
   */
  "review_request", "review", "review_platform", "review_policy",
  "attachment", "stored_file",
  "audit_log", "integration_event", "travel_time",
  /**
   * A delivery attempt points at its endpoint and at the replay that sent
   * it, and a replay at its endpoint, so the attempts go first.
   */
  "webhook_delivery", "webhook_replay", "webhook_endpoint",
  /**
   * A held certification points at a technician and at the type it is an
   * instance of, so both go before the technician below and the type goes
   * after the holdings of it.
   */
  "person_certification",
  /**
   * The rest of what the office keeps about a person: continuing education
   * and skills point at the technician (and the hours at a certification
   * type), the others at the membership, and a person's onboarding line at
   * the template line it was copied from and the asset handed over.
   */
  "continuing_education", "technician_skill",
  "onboarding_item", "onboarding_template_item",
  /**
   * A request to sign points at the document and the person, and an onboarding
   * line at the document, so the lines and the requests go before it. An
   * invite points at the person, and the email it went as points at the
   * invite; the email is gone with the other messages above.
   */
  "staff_document_request", "staff_document", "membership_invite",
  "emergency_contact", "employment_record",
  "certification_type",
  "custom_field_definition", "custom_object_type", "time_off", "on_call_rotation", "technician",
  "network_grant", "regulatory_constant",
  /**
   * Roles before memberships. The foreign key is ON DELETE SET NULL so the
   * order does not strictly matter, but a custom role outliving the
   * organization that defined it is the kind of fixture leftover that makes
   * the next run fail on a unique name rather than on anything real.
   */
  "role",
  "membership", "business_unit", "location",
] as const;

export async function resetOrg(sql: postgres.Sql, organizationId: string): Promise<void> {
  /**
   * The ledger refuses a DELETE, by a trigger, on purpose. That is correct and
   * it is one of the properties this whole project rests on, so the answer is
   * not to weaken the trigger for the convenience of a test.
   *
   * `session_replication_role = replica` suspends user triggers for THIS
   * SESSION only. It is the standard mechanism for bulk loading and teardown,
   * it requires superuser, and it is restored immediately below. Nothing about
   * the trigger changes; this session simply steps around it for the duration
   * of a cleanup that is deleting test data rather than correcting a book.
   *
   * If this line ever appears outside a test helper, that is a bug.
   */
  await sql.unsafe(`set session_replication_role = replica`);
  try {
    for (const table of ORDER) {
      await sql.unsafe(`delete from public.${table} where organization_id = $1`, [organizationId]);
    }
    await sql.unsafe(`delete from public.organization where id = $1`, [organizationId]);
  } finally {
    await sql.unsafe(`set session_replication_role = origin`);
  }
}

export async function seedOrg(
  sql: postgres.Sql,
  opts: { organizationId: string; userId: string; name: string; slug: string },
): Promise<void> {
  await resetOrg(sql, opts.organizationId);

  /**
   * The slug is unique across the database, so a stale organization still
   * holding it blocks this insert with a message about an index rather than
   * about the fixture. That happens whenever a suite's ids change and the old
   * rows survive, which is exactly when a clear error matters most.
   */
  const stale = await sql.unsafe<{ id: string }[]>(
    `select id from public.organization where slug = $1 and id <> $2`,
    [opts.slug, opts.organizationId],
  );
  for (const row of stale) await resetOrg(sql, row.id);

  /**
   * Users are not tenant scoped, so `resetOrg` does not reach them, and the
   * email is unique. Clear both the id this fixture wants and anyone still
   * holding the address, for the same reason as the slug above.
   */
  await sql.unsafe(
    `delete from public."user" where id = $1 or email = $2`,
    [opts.userId, `${opts.slug}@test.local`],
  );
  await sql.unsafe(
    `insert into public.organization (id, name, slug) values ($1, $2, $3)`,
    [opts.organizationId, opts.name, opts.slug],
  );
  await sql.unsafe(
    `insert into public."user" (id, email) values ($1, $2) on conflict (id) do nothing`,
    [opts.userId, `${opts.slug}@test.local`],
  );
  await sql.unsafe(
    `insert into public.membership (organization_id, user_id, role) values ($1, $2, 'owner')`,
    [opts.organizationId, opts.userId],
  );
}

/**
 * Every tenant table this helper knows how to delete.
 *
 * Exported so a test can assert that the list is complete. It has been
 * incomplete before: a table added to the schema and not added here is not
 * caught by the compiler, and it surfaces as a foreign key failure in some
 * other file's beforeAll, which vitest then reports as SKIPPED rather than
 * failed. The cost is a whole suite silently not running.
 */
export const TEARDOWN_ORDER: readonly string[] = ORDER;

/**
 * A fixture id derived from a name.
 *
 * Hand-picked uuids collide. Two files in this directory independently chose
 * `eeee1111-1111-1111-1111-111111111111`, and because `seedOrg` resets the
 * organization it is about to seed, one file's beforeAll deleted the other
 * file's fixtures halfway through the run. Each file passed on its own and the
 * pair failed together, which is the worst way to find out.
 *
 * Deriving the id from a name makes a collision require picking the same name,
 * which is visible rather than arithmetic.
 */
/**
 * A date as the seeded company counts days, `offset` days from today.
 *
 * Not `new Date().toISOString().slice(0, 10)`: that is UTC's date, and for
 * the hours after midnight UTC it is already tomorrow where the company is
 * (America/Chicago, the column's default), so a visit made "now" falls
 * outside a day asked for by it and a date "today" is refused as the future.
 */
export function companyToday(offset = 0, timeZone = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() + offset * 86_400_000));
}

export function fixtureId(name: string): string {
  const h = createHash("sha256").update(name).digest("hex");
  return [
    h.slice(0, 8), h.slice(8, 12),
    // Version 4 and the RFC variant bits, so it is a well formed uuid.
    `4${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * One client for the whole test run.
 *
 * `createClient` opens a fresh pool of ten connections every time it is
 * called, which is right for a migration and wrong for a test helper that
 * builds a ServiceContext. Each file was calling it once per context, so the
 * suite opened a pool per assertion and eventually Postgres refused with
 * "sorry, too many clients already" from a test that had nothing to do with
 * connections.
 *
 * The same mistake, in the request path, is what apps/web/src/lib/db.ts
 * exists to prevent.
 */
let shared: Database | undefined;

export function testDb(url: string): Database {
  shared ??= createClient(url);
  return shared;
}

/**
 * ONE WHOLE PASS AT A TIME
 *
 * The worker's pass reads every company with unread events, not the one a
 * test made, so two files running a pass at once take each other's events:
 * the file that asserts what its own drain handled finds the other file's
 * pass got there first. Production is safe either way (a run is keyed on its
 * event, so the second worker records it as already run); the tests are not,
 * because they assert which pass did the work. Every file that runs a pass
 * over all companies, or drains one and asserts what it handled, holds this
 * lock for the whole file, so those files take turns while the rest of the
 * suite runs beside them.
 *
 * A session lock on its own connection, released when the file ends.
 */
const WHOLE_PASS_LOCK = 7_101_001;
export const WHOLE_PASS_WAIT_MS = 1_800_000;

export async function holdWholePassLock(url: string): Promise<() => Promise<void>> {
  const conn = postgres(url, { max: 1, onnotice: () => undefined });
  await conn`select pg_advisory_lock(${WHOLE_PASS_LOCK})`;
  return async () => {
    await conn`select pg_advisory_unlock(${WHOLE_PASS_LOCK})`;
    await conn.end();
  };
}
