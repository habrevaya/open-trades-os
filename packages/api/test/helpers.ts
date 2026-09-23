import type postgres from "postgres";
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
  // Money first, since it references almost everything.
  "ledger_entry", "deferred_revenue_entry", "payment_allocation", "payment",
  "invoice_delivery", "invoice_line", "invoice",
  "deposit", "estimate_line", "estimate_option", "estimate", "document_signature",
  "agreement_billing", "agreement_visit", "agreement", "agreement_plan",
  // Then work.
  "delivery",
  "obligation", "authorization", "external_work_order",
  "service_report_field", "service_report", "visit_asset", "visit_assignment",
  "job_line",
  "visit", "entitlement", "job_party", "job", "job_type",
  // Then the things work points at.
  "deficiency", "inspection", "inspection_program",
  "equipment_move", "equipment",
  "customer_property", "contact", "property", "customer",
  "price_book_item_version", "price_book_item", "price_book_category",
  "rate_card_line", "rate_card", "contract_site", "service_contract",
  "timeclock_entry", "overtime_policy", "wage_scale",
  "field_upload", "field_operation", "device_snapshot", "device",
  "arrival_notice",
  // Automation. A step run points at a run, a run at a version, a version at
  // a workflow. Events are last because a run references one.
  // Tasks before runs: a task points at the run that raised it.
  // Inventory, in dependency order: movements reference orders and lines,
  // lines reference an order, and a reorder policy references a vendor.
  "stock_movement", "purchase_order_line", "purchase_order", "reorder_policy", "vendor",
  // A dashboard's tiles point at reports by id inside jsonb, which no foreign
  // key enforces, so the order here is for the reader rather than for the
  // database: the thing pointing goes before the thing pointed at.
  "dashboard", "report",
  // The company's own logo and favicon, which are bytes rather than a key.
  "brand_asset",
  "task",
  "workflow_step_run", "workflow_run", "workflow_schedule", "workflow_version", "workflow",
  "event_cursor", "domain_event",
  // Communications, in dependency order: a message points at a conversation
  // and a consent row, a call points at a number, a number points at a
  // campaign, a campaign points at a brand.
  "message", "call", "conversation",
  "suppression", "communication_consent", "message_template",
  // Nothing points at a recording policy: it is matched by jurisdiction
  // string, never by id, which is why a party's jurisdiction can name a
  // place the operator has not declared.
  "recording_policy",
  "phone_number", "messaging_campaign", "messaging_brand",
  "portal_event", "portal_grant",
  "booking_request", "bookable_service", "arrival_window",
  "portal_block", "portal_layout", "service_report_template",
  "retention_policy", "regulatory_submission",
  "recurring_schedule", "route_stop", "route", "crew_member", "crew",
  "rental", "rentable_asset", "territory", "business_hours",
  "lead_offer", "lead_source_connector", "sync_run", "integration_connection",
  // An app's tokens, then the app. Both cascade from the organization, but a
  // scoped reset deletes rows rather than the tenant, so they need naming.
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
  "attachment", "stored_file",
  "audit_log", "integration_event", "webhook_endpoint",
  "custom_field_definition", "time_off", "on_call_rotation", "technician",
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
