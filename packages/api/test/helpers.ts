import type postgres from "postgres";

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
  "agreement_billing", "agreement_visit", "agreement", "agreement_plan",
  // Then work.
  "obligation", "authorization", "external_work_order",
  "service_report_field", "service_report", "visit_asset", "visit_assignment",
  "visit", "entitlement", "job_party", "job", "job_type",
  // Then the things work points at.
  "deficiency", "inspection", "inspection_program",
  "equipment_move", "equipment",
  "customer_property", "contact", "property", "customer",
  "price_book_item_version", "price_book_item", "price_book_category",
  "rate_card_line", "rate_card", "contract_site", "service_contract",
  "timeclock_entry", "wage_scale",
  "portal_block", "portal_layout", "service_report_template",
  "retention_policy", "regulatory_submission",
  "recurring_schedule", "route_stop", "route", "crew_member", "crew",
  "rental", "rentable_asset", "territory", "business_hours",
  "lead_offer", "lead_source_connector", "sync_run", "integration_connection",
  "attachment", "audit_log", "integration_event", "webhook_endpoint",
  "custom_field_definition", "time_off", "on_call_rotation", "technician",
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
  await sql.unsafe(`delete from public."user" where id = $1`, [opts.userId]);
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
