CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'office_manager', 'dispatcher', 'csr', 'technician', 'crew_lead', 'accountant', 'readonly');--> statement-breakpoint
CREATE TYPE "public"."network_kind" AS ENUM('franchise', 'holding', 'cooperative');--> statement-breakpoint
CREATE TYPE "public"."customer_property_role" AS ENUM('owner', 'tenant', 'manager', 'billing');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('residential', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."item_kind" AS ENUM('service', 'material', 'equipment', 'labor', 'fee', 'discount');--> statement-breakpoint
CREATE TYPE "public"."capacity_model" AS ENUM('technician_dispatch', 'crew_production', 'route', 'asset_rental');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('lead', 'estimating', 'scheduled', 'in_progress', 'on_hold', 'completed', 'invoiced', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('unassigned', 'scheduled', 'dispatched', 'en_route', 'working', 'completed', 'cancelled', 'no_show', 'completed_after_cancellation');--> statement-breakpoint
CREATE TYPE "public"."authorization_state" AS ENUM('requested', 'granted', 'exceeded', 'denied', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."external_work_order_state" AS ENUM('offered', 'accepted', 'rejected', 'in_progress', 'completed', 'cancelled_by_client', 'reopened', 'invoiced', 'closed');--> statement-breakpoint
CREATE TYPE "public"."invoice_delivery_channel" AS ENUM('email', 'portal_link', 'fm_network_api', 'cxml', 'edi', 'mail', 'manual');--> statement-breakpoint
CREATE TYPE "public"."obligation_state" AS ENUM('open', 'satisfied', 'breached', 'waived', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM('requester', 'site_contact', 'approver', 'bill_to', 'payer', 'referrer', 'owner');--> statement-breakpoint
CREATE TYPE "public"."coverage_source" AS ENUM('customer', 'agreement', 'parts_warranty', 'labour_warranty', 'our_warranty', 'home_warranty', 'insurance', 'goodwill', 'no_charge_callback', 'contract');--> statement-breakpoint
CREATE TYPE "public"."deficiency_severity" AS ENUM('critical', 'major', 'minor', 'advisory');--> statement-breakpoint
CREATE TYPE "public"."deficiency_status" AS ENUM('open', 'quoted', 'approved', 'scheduled', 'corrected', 'declined', 'deferred', 'void');--> statement-breakpoint
CREATE TYPE "public"."inspection_result" AS ENUM('pass', 'pass_with_deficiencies', 'fail', 'not_tested', 'not_accessible', 'partial');--> statement-breakpoint
CREATE TYPE "public"."retention_clock_start" AS ENUM('record_created', 'calendar_year_end', 'work_completed', 'report_prepared', 'employment_ended', 'next_activity_of_type', 'contract_ended', 'equipment_removed');--> statement-breakpoint
CREATE TYPE "public"."submission_state" AS ENUM('due', 'prepared', 'submitted', 'acknowledged', 'rejected', 'resubmitted', 'waived');--> statement-breakpoint
CREATE TYPE "public"."portal_block_kind" AS ENUM('visit_timeline', 'service_report', 'readings_trend', 'equipment_register', 'checklist_results', 'photo_gallery', 'documents', 'invoices', 'payments', 'plan_status', 'next_visit', 'recommended_work', 'referral', 'contact_card');--> statement-breakpoint
CREATE TYPE "public"."reading_kind" AS ENUM('numeric', 'text', 'boolean', 'select', 'photo', 'signature', 'chemical', 'measurement');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('draft', 'sent', 'viewed', 'approved', 'declined', 'expired', 'converted');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'open', 'partially_paid', 'paid', 'void', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."line_origin" AS ENUM('job', 'delivery', 'rental_period', 'contract_schedule', 'membership', 'manual', 'fee');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('card', 'card_present', 'ach', 'cash', 'check', 'financing', 'credit', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."time_entry_kind" AS ENUM('job', 'travel', 'shop', 'training', 'break', 'on_call', 'pto', 'holiday');--> statement-breakpoint
CREATE TYPE "public"."wage_authority" AS ENUM('employee_default', 'collective_agreement', 'wage_determination', 'contract', 'manual_override');--> statement-breakpoint
CREATE TYPE "public"."capability" AS ENUM('payments', 'telephony', 'messaging', 'email', 'accounting', 'maps', 'routing', 'storage', 'calendar', 'payroll', 'financing', 'tax', 'ai_model', 'reviews', 'ads', 'analytics', 'lead_source');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'connected', 'needs_reauth', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."lead_offer_status" AS ENUM('offered', 'accepted', 'declined', 'expired', 'withdrawn', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sync_direction" AS ENUM('inbound', 'outbound', 'bidirectional');--> statement-breakpoint
CREATE TYPE "public"."integration_event_status" AS ENUM('pending', 'in_flight', 'succeeded', 'failed', 'abandoned');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"timezone" text,
	"is_warehouse" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'technician' NOT NULL,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"business_unit_id" uuid,
	"location_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "network_kind" DEFAULT 'holding' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"operator_organization_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"aggregate" text NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text,
	"ein" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"logo_url" text,
	"brand_color" text,
	"primary_trade" text,
	"setup_completed_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"network_id" uuid,
	"network_member_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_organization_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "technician" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"color" text,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"licenses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"home_location_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"name" text,
	"avatar_url" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid,
	"property_id" uuid,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"phone" text,
	"preferred_channel" text DEFAULT 'sms' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sms_consent_at" timestamp with time zone,
	"email_opt_out_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "customer_type" DEFAULT 'residential' NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"billing_address_line1" text,
	"billing_address_line2" text,
	"billing_city" text,
	"billing_state" text,
	"billing_postal_code" text,
	"billing_country" text DEFAULT 'US' NOT NULL,
	"lead_source" text,
	"payment_terms_days" text DEFAULT '0' NOT NULL,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"tax_exempt_certificate" text,
	"discount_rate" numeric(14, 4),
	"do_not_service" boolean DEFAULT false NOT NULL,
	"do_not_service_reason" text,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_property" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"role" "customer_property_role" DEFAULT 'owner' NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"started_on" date,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"parent_equipment_id" uuid,
	"tag" text,
	"category" text NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"installed_on" date,
	"installed_by_us" boolean DEFAULT false NOT NULL,
	"warranty_parts_expires_on" date,
	"warranty_labor_expires_on" date,
	"location" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "property" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"nickname" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"latitude" text,
	"longitude" text,
	"territory_id" uuid,
	"tax_jurisdiction_id" uuid,
	"square_feet" text,
	"year_built" text,
	"gate_code" text,
	"access_notes" text,
	"hazard_notes" text,
	"has_dog" boolean DEFAULT false NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_book_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"code" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_book_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid,
	"kind" "item_kind" DEFAULT 'service' NOT NULL,
	"code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"trade_pack_id" text,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_book_item_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"price" numeric(14, 4) NOT NULL,
	"cost" numeric(14, 4),
	"labor_minutes" integer,
	"taxable" boolean DEFAULT true NOT NULL,
	"tax_class" text,
	"commission_rate" numeric(9, 6),
	"warranty_months" integer,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"day_of_week" integer NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crew" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"business_unit_id" uuid,
	"home_location_id" uuid,
	"production_rate_per_day" numeric(14, 4),
	"production_unit" text,
	"required_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"color" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crew_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"crew_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "on_call_rotation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"technician_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"rate_multiplier" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rentable_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"identifier" text NOT NULL,
	"size" text,
	"home_location_id" uuid,
	"current_property_id" uuid,
	"status" text DEFAULT 'available' NOT NULL,
	"purchase_cost" numeric(14, 4),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rental" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"included_days" integer,
	"daily_rate" numeric(14, 4),
	"overage_rate" numeric(14, 4),
	"weight_tons" numeric(14, 4),
	"disposal_fee" numeric(14, 4),
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"territory_id" uuid,
	"technician_id" uuid,
	"crew_id" uuid,
	"day_of_week" integer,
	"target_stop_count" integer,
	"starts_at" time,
	"color" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_stop" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"estimated_minutes" integer DEFAULT 20 NOT NULL,
	"interval_days" integer,
	"last_serviced_on" date,
	"next_due_on" date,
	"price_per_stop" numeric(14, 4),
	"active" boolean DEFAULT true NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "territory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"postal_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"boundary" jsonb,
	"home_location_id" uuid,
	"travel_fee" numeric(14, 4),
	"color" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_type_id" uuid,
	"territory_id" uuid,
	"production_quantity" numeric(14, 4),
	"business_unit_id" uuid,
	"status" "job_status" DEFAULT 'lead' NOT NULL,
	"summary" text NOT NULL,
	"description" text,
	"customer_complaint" text,
	"equipment_id" uuid,
	"lead_source" text,
	"campaign_id" uuid,
	"price_source" text DEFAULT 'price_book' NOT NULL,
	"rate_card_id" uuid,
	"contract_id" uuid,
	"purchase_order_number" text,
	"cost_code" text,
	"parent_job_id" uuid,
	"is_warranty" boolean DEFAULT false NOT NULL,
	"agreement_id" uuid,
	"priority" integer DEFAULT 0 NOT NULL,
	"total" numeric(14, 4),
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"capacity_model" "capacity_model" DEFAULT 'technician_dispatch' NOT NULL,
	"production_unit" text,
	"default_duration_minutes" integer DEFAULT 60 NOT NULL,
	"required_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checklist_template" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_unit_id" uuid,
	"color" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"status" "visit_status" DEFAULT 'unassigned' NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"estimated_duration_minutes" integer DEFAULT 60 NOT NULL,
	"location_id" uuid,
	"route_order" integer,
	"crew_id" uuid,
	"route_id" uuid,
	"route_stop_id" uuid,
	"rental_id" uuid,
	"rental_event" text,
	"dispatched_at" timestamp with time zone,
	"en_route_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"technician_notes" text,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signature_url" text,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visit_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid,
	"estimate_id" uuid,
	"state" "authorization_state" DEFAULT 'requested' NOT NULL,
	"amount" numeric(14, 4),
	"consumed_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"granted_by_party_id" uuid,
	"granted_by_name" text,
	"external_reference" text,
	"granted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"supersedes_id" uuid,
	"scope_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"site_number" text,
	"not_to_exceed" numeric(14, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_work_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid,
	"source_system" text NOT NULL,
	"external_id" text NOT NULL,
	"external_number" text,
	"state" "external_work_order_state" DEFAULT 'offered' NOT NULL,
	"external_status" text,
	"external_is_system_of_record" boolean DEFAULT true NOT NULL,
	"acceptance_is_irreversible" boolean DEFAULT false NOT NULL,
	"accepts_via_invoice_only" boolean DEFAULT false NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"pending_push" boolean DEFAULT false NOT NULL,
	"last_push_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"channel" "invoice_delivery_channel" NOT NULL,
	"destination" text,
	"external_reference" text,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"dispute_reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_party" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"role" "party_role" NOT NULL,
	"customer_id" uuid,
	"contact_id" uuid,
	"external_name" text,
	"external_reference" text,
	"share_percent" numeric(9, 6),
	"share_amount" numeric(14, 4),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "obligation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"state" "obligation_state" DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"satisfied_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"satisfied_by_event" text,
	"consequence" text,
	"escalate_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contract_id" uuid,
	"authority" text DEFAULT 'contract' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_card_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rate_card_id" uuid NOT NULL,
	"external_code" text,
	"price_book_item_id" uuid,
	"description" text NOT NULL,
	"unit" text,
	"price" numeric(14, 4) NOT NULL,
	"allowed_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contract_number" text,
	"starts_on" date,
	"ends_on" date,
	"auto_renews" boolean DEFAULT false NOT NULL,
	"escalation_rate" numeric(9, 6),
	"default_not_to_exceed" numeric(14, 4),
	"purchase_order_number" text,
	"sla_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"covered_scope" text,
	"active" boolean DEFAULT true NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entitlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" "coverage_source" DEFAULT 'customer' NOT NULL,
	"job_id" uuid,
	"visit_id" uuid,
	"equipment_id" uuid,
	"granting_entity_type" text,
	"granting_entity_id" uuid,
	"external_reference" text,
	"covers_labour" boolean DEFAULT false NOT NULL,
	"covers_parts" boolean DEFAULT false NOT NULL,
	"covers_trip" boolean DEFAULT false NOT NULL,
	"coverage_percent" numeric(9, 6),
	"coverage_limit" numeric(14, 4),
	"customer_responsibility" numeric(14, 4),
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equipment_move" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"from_property_id" uuid,
	"to_property_id" uuid,
	"reason" text NOT NULL,
	"moved_on" date NOT NULL,
	"job_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "visit_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deficiency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inspection_id" uuid,
	"property_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"equipment_id" uuid,
	"status" "deficiency_status" DEFAULT 'open' NOT NULL,
	"severity" "deficiency_severity" DEFAULT 'minor' NOT NULL,
	"checkpoint_key" text,
	"code" text,
	"description" text NOT NULL,
	"recommended_action" text,
	"found_on" date,
	"correct_by_on" date,
	"corrected_on" date,
	"corrected_by_job_id" uuid,
	"estimate_id" uuid,
	"quoted_amount" numeric(14, 4),
	"declined_on" date,
	"decline_reason" text,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_id" uuid,
	"visit_id" uuid,
	"equipment_id" uuid,
	"product" text NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"meter_start" numeric(14, 4),
	"meter_stop" numeric(14, 4),
	"was_partial_fill" boolean DEFAULT false NOT NULL,
	"tank_percent_before" numeric(14, 4),
	"tank_percent_after" numeric(14, 4),
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inspection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" uuid,
	"program_version" integer,
	"property_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"contract_id" uuid,
	"job_id" uuid,
	"visit_id" uuid,
	"performed_on" date,
	"result" "inspection_result",
	"inspector_name" text,
	"inspector_license" text,
	"next_due_on" date,
	"submitted_at" timestamp with time zone,
	"submission_reference" text,
	"submission_rejected_at" timestamp with time zone,
	"submission_rejection_reason" text,
	"report_url" text,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inspection_program" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"standard" text,
	"trade_pack_id" text,
	"report_audience" text DEFAULT 'customer' NOT NULL,
	"authority_name" text,
	"frequency_months" integer,
	"checkpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "regulatory_constant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"jurisdiction" text DEFAULT 'US' NOT NULL,
	"value" text NOT NULL,
	"unit" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "regulatory_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"authority_name" text NOT NULL,
	"jurisdiction" text,
	"period_start" date,
	"period_end" date,
	"state" "submission_state" DEFAULT 'due' NOT NULL,
	"due_on" date,
	"route" text,
	"formatter" text,
	"formatter_version" integer,
	"submitted_at" timestamp with time zone,
	"acknowledgement_reference" text,
	"acknowledged_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"supersedes_id" uuid,
	"payload" jsonb,
	"document_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_kind" text,
	"clock_start" "retention_clock_start" DEFAULT 'record_created' NOT NULL,
	"retain_months" integer NOT NULL,
	"basis" text,
	"trade_pack_id" text,
	"purge_allowed" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"layout_id" uuid NOT NULL,
	"kind" "portal_block_kind" NOT NULL,
	"title" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_layout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trade_pack_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"summary" text,
	"technician_notes" text,
	"observations" text,
	"skipped" boolean DEFAULT false NOT NULL,
	"skip_reason" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_report_field" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"equipment_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" "reading_kind" NOT NULL,
	"value_numeric" numeric(14, 4),
	"value_text" text,
	"value_boolean" boolean,
	"unit" text,
	"product_name" text,
	"epa_registration_number" text,
	"quantity_applied" numeric(14, 4),
	"application_unit" text,
	"applicator_license" text,
	"target_pest" text,
	"customer_visible" boolean DEFAULT true NOT NULL,
	"out_of_range" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_report_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"job_type_id" uuid,
	"trade_pack_id" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_id" uuid,
	"status" "estimate_status" DEFAULT 'draft' NOT NULL,
	"title" text,
	"expires_on" date,
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"selected_option_id" uuid,
	"signature_url" text,
	"signer_name" text,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "estimate_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"subtotal" numeric(14, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"job_id" uuid,
	"business_unit_id" uuid,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"payer_customer_id" uuid,
	"payer_external_name" text,
	"payer_reference" text,
	"purchase_order_number" text,
	"cost_code" text,
	"contract_id" uuid,
	"authorization_id" uuid,
	"issued_on" date,
	"due_on" date,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"subtotal" numeric(14, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(14, 4) DEFAULT '0' NOT NULL,
	"balance" numeric(14, 4) DEFAULT '0' NOT NULL,
	"deposit_held" numeric(14, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	"voided_at" timestamp with time zone,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"origin" "line_origin" DEFAULT 'job' NOT NULL,
	"origin_id" uuid,
	"entitlement_id" uuid,
	"price_book_item_version_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(14, 4),
	"discount_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"tax_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 4) DEFAULT '0' NOT NULL,
	"cost_code" text,
	"rate_card_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"account_code" text NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"customer_id" uuid,
	"job_id" uuid,
	"reverses_entry_id" uuid,
	"memo" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"fee_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"tip_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"surcharge_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"refunded_amount" numeric(14, 4) DEFAULT '0' NOT NULL,
	"processor" text DEFAULT 'stripe' NOT NULL,
	"processor_payment_id" text,
	"idempotency_key" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_number" text,
	"notes" text,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timeclock_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"kind" time_entry_kind DEFAULT 'job' NOT NULL,
	"job_id" uuid,
	"visit_id" uuid,
	"business_unit_id" uuid,
	"cost_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"minutes" integer,
	"wage_scale_id" uuid,
	"classification" text,
	"work_class_code" text,
	"applied_base_rate" numeric(14, 4),
	"applied_fringe_rate" numeric(14, 4),
	"applied_loaded_rate" numeric(14, 4),
	"overtime_minutes" integer,
	"double_time_minutes" integer,
	"start_latitude" text,
	"start_longitude" text,
	"end_latitude" text,
	"end_longitude" text,
	"geofence_satisfied" boolean,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"edited_at" timestamp with time zone,
	"edit_reason" text,
	"source_system" text,
	"source_id" text,
	"source_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wage_scale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"authority" "wage_authority" DEFAULT 'employee_default' NOT NULL,
	"classification" text NOT NULL,
	"jurisdiction" text,
	"external_reference" text,
	"base_rate" numeric(14, 4) NOT NULL,
	"fringe_rate" numeric(14, 4),
	"overtime_multiplier" numeric(9, 6),
	"double_time_multiplier" numeric(9, 6),
	"apprentice_ratio" text,
	"effective_from" date,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability" "capability" NOT NULL,
	"provider" text NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"account_label" text,
	"credential_ref" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"status" "lead_offer_status" DEFAULT 'offered' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"service_requested" text,
	"address_line1" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"estimated_value" numeric(14, 4),
	"expires_at" timestamp with time zone,
	"customer_id" uuid,
	"property_id" uuid,
	"job_id" uuid,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decline_reason" text,
	"payout_expected" numeric(14, 4),
	"payout_received" numeric(14, 4),
	"payout_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_source_connector" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"source" text NOT NULL,
	"display_name" text NOT NULL,
	"auto_accept_enabled" boolean DEFAULT false NOT NULL,
	"auto_accept_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"commission_rate" numeric(14, 4),
	"lead_fee" numeric(14, 4),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"direction" "sync_direction" NOT NULL,
	"entity_type" text,
	"cursor" text,
	"records_read" integer DEFAULT 0 NOT NULL,
	"records_written" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" text DEFAULT 'photo' NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text,
	"content_type" text,
	"size_bytes" integer,
	"phase" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_agent_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_field_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"data_type" text DEFAULT 'text' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "integration_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"error" text,
	"entity_type" text,
	"entity_id" uuid,
	"next_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_ref" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_unit" ADD CONSTRAINT "business_unit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credential" ADD CONSTRAINT "credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "location" ADD CONSTRAINT "location_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership" ADD CONSTRAINT "membership_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership" ADD CONSTRAINT "membership_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "network_grant" ADD CONSTRAINT "network_grant_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "network_grant" ADD CONSTRAINT "network_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization" ADD CONSTRAINT "organization_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session" ADD CONSTRAINT "session_active_organization_id_organization_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician" ADD CONSTRAINT "technician_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician" ADD CONSTRAINT "technician_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "technician" ADD CONSTRAINT "technician_home_location_id_location_id_fk" FOREIGN KEY ("home_location_id") REFERENCES "public"."location"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact" ADD CONSTRAINT "contact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact" ADD CONSTRAINT "contact_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact" ADD CONSTRAINT "contact_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer" ADD CONSTRAINT "customer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_property" ADD CONSTRAINT "customer_property_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_property" ADD CONSTRAINT "customer_property_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_property" ADD CONSTRAINT "customer_property_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equipment" ADD CONSTRAINT "equipment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equipment" ADD CONSTRAINT "equipment_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property" ADD CONSTRAINT "property_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_category" ADD CONSTRAINT "price_book_category_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_item" ADD CONSTRAINT "price_book_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_item" ADD CONSTRAINT "price_book_item_category_id_price_book_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_book_category"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_item_version" ADD CONSTRAINT "price_book_item_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_item_version" ADD CONSTRAINT "price_book_item_version_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew" ADD CONSTRAINT "crew_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew" ADD CONSTRAINT "crew_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew" ADD CONSTRAINT "crew_home_location_id_location_id_fk" FOREIGN KEY ("home_location_id") REFERENCES "public"."location"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "on_call_rotation" ADD CONSTRAINT "on_call_rotation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "on_call_rotation" ADD CONSTRAINT "on_call_rotation_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "on_call_rotation" ADD CONSTRAINT "on_call_rotation_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentable_asset" ADD CONSTRAINT "rentable_asset_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentable_asset" ADD CONSTRAINT "rentable_asset_home_location_id_location_id_fk" FOREIGN KEY ("home_location_id") REFERENCES "public"."location"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rentable_asset" ADD CONSTRAINT "rentable_asset_current_property_id_property_id_fk" FOREIGN KEY ("current_property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental" ADD CONSTRAINT "rental_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental" ADD CONSTRAINT "rental_asset_id_rentable_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."rentable_asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rental" ADD CONSTRAINT "rental_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route" ADD CONSTRAINT "route_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route" ADD CONSTRAINT "route_territory_id_territory_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territory"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route" ADD CONSTRAINT "route_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route" ADD CONSTRAINT "route_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_route_id_route_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."route"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "territory" ADD CONSTRAINT "territory_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "territory" ADD CONSTRAINT "territory_home_location_id_location_id_fk" FOREIGN KEY ("home_location_id") REFERENCES "public"."location"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_off" ADD CONSTRAINT "time_off_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_job_type_id_job_type_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_type"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_territory_id_territory_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territory"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job" ADD CONSTRAINT "job_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_type" ADD CONSTRAINT "job_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_type" ADD CONSTRAINT "job_type_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit" ADD CONSTRAINT "visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit" ADD CONSTRAINT "visit_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit" ADD CONSTRAINT "visit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit" ADD CONSTRAINT "visit_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit" ADD CONSTRAINT "visit_route_id_route_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."route"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit" ADD CONSTRAINT "visit_route_stop_id_route_stop_id_fk" FOREIGN KEY ("route_stop_id") REFERENCES "public"."route_stop"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit" ADD CONSTRAINT "visit_rental_id_rental_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rental"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_assignment" ADD CONSTRAINT "visit_assignment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_assignment" ADD CONSTRAINT "visit_assignment_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_assignment" ADD CONSTRAINT "visit_assignment_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authorization" ADD CONSTRAINT "authorization_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authorization" ADD CONSTRAINT "authorization_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authorization" ADD CONSTRAINT "authorization_granted_by_party_id_job_party_id_fk" FOREIGN KEY ("granted_by_party_id") REFERENCES "public"."job_party"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_site" ADD CONSTRAINT "contract_site_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_site" ADD CONSTRAINT "contract_site_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_site" ADD CONSTRAINT "contract_site_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_work_order" ADD CONSTRAINT "external_work_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_work_order" ADD CONSTRAINT "external_work_order_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_delivery" ADD CONSTRAINT "invoice_delivery_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_party" ADD CONSTRAINT "job_party_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_party" ADD CONSTRAINT "job_party_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_party" ADD CONSTRAINT "job_party_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_party" ADD CONSTRAINT "job_party_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obligation" ADD CONSTRAINT "obligation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rate_card_line" ADD CONSTRAINT "rate_card_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rate_card_line" ADD CONSTRAINT "rate_card_line_rate_card_id_rate_card_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rate_card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_contract" ADD CONSTRAINT "service_contract_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_contract" ADD CONSTRAINT "service_contract_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equipment_move" ADD CONSTRAINT "equipment_move_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equipment_move" ADD CONSTRAINT "equipment_move_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equipment_move" ADD CONSTRAINT "equipment_move_from_property_id_property_id_fk" FOREIGN KEY ("from_property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equipment_move" ADD CONSTRAINT "equipment_move_to_property_id_property_id_fk" FOREIGN KEY ("to_property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equipment_move" ADD CONSTRAINT "equipment_move_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_asset" ADD CONSTRAINT "visit_asset_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_asset" ADD CONSTRAINT "visit_asset_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "visit_asset" ADD CONSTRAINT "visit_asset_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deficiency" ADD CONSTRAINT "deficiency_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deficiency" ADD CONSTRAINT "deficiency_inspection_id_inspection_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspection"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deficiency" ADD CONSTRAINT "deficiency_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deficiency" ADD CONSTRAINT "deficiency_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deficiency" ADD CONSTRAINT "deficiency_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deficiency" ADD CONSTRAINT "deficiency_corrected_by_job_id_job_id_fk" FOREIGN KEY ("corrected_by_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery" ADD CONSTRAINT "delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery" ADD CONSTRAINT "delivery_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery" ADD CONSTRAINT "delivery_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery" ADD CONSTRAINT "delivery_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery" ADD CONSTRAINT "delivery_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery" ADD CONSTRAINT "delivery_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_program_id_inspection_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."inspection_program"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_contract_id_service_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."service_contract"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_program" ADD CONSTRAINT "inspection_program_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "regulatory_constant" ADD CONSTRAINT "regulatory_constant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "regulatory_submission" ADD CONSTRAINT "regulatory_submission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_block" ADD CONSTRAINT "portal_block_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_block" ADD CONSTRAINT "portal_block_layout_id_portal_layout_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."portal_layout"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_layout" ADD CONSTRAINT "portal_layout_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report" ADD CONSTRAINT "service_report_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report" ADD CONSTRAINT "service_report_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report" ADD CONSTRAINT "service_report_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report" ADD CONSTRAINT "service_report_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report" ADD CONSTRAINT "service_report_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report" ADD CONSTRAINT "service_report_template_id_service_report_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."service_report_template"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report_field" ADD CONSTRAINT "service_report_field_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report_field" ADD CONSTRAINT "service_report_field_report_id_service_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."service_report"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report_field" ADD CONSTRAINT "service_report_field_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report_field" ADD CONSTRAINT "service_report_field_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_report_template" ADD CONSTRAINT "service_report_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_option" ADD CONSTRAINT "estimate_option_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate_option" ADD CONSTRAINT "estimate_option_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_payer_customer_id_customer_id_fk" FOREIGN KEY ("payer_customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_price_book_item_version_id_price_book_item_version_id_fk" FOREIGN KEY ("price_book_item_version_id") REFERENCES "public"."price_book_item_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment" ADD CONSTRAINT "payment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeclock_entry" ADD CONSTRAINT "timeclock_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeclock_entry" ADD CONSTRAINT "timeclock_entry_technician_id_technician_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technician"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeclock_entry" ADD CONSTRAINT "timeclock_entry_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeclock_entry" ADD CONSTRAINT "timeclock_entry_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeclock_entry" ADD CONSTRAINT "timeclock_entry_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeclock_entry" ADD CONSTRAINT "timeclock_entry_wage_scale_id_wage_scale_id_fk" FOREIGN KEY ("wage_scale_id") REFERENCES "public"."wage_scale"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wage_scale" ADD CONSTRAINT "wage_scale_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer" ADD CONSTRAINT "lead_offer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer" ADD CONSTRAINT "lead_offer_connector_id_lead_source_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."lead_source_connector"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer" ADD CONSTRAINT "lead_offer_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer" ADD CONSTRAINT "lead_offer_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_offer" ADD CONSTRAINT "lead_offer_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_source_connector" ADD CONSTRAINT "lead_source_connector_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_source_connector" ADD CONSTRAINT "lead_source_connector_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachment" ADD CONSTRAINT "attachment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_field_definition" ADD CONSTRAINT "custom_field_definition_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_event" ADD CONSTRAINT "integration_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_unit_org_idx" ON "business_unit" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credential_user_idx" ON "credential" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "location_org_idx" ON "location" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "membership_org_user_idx" ON "membership" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "network_slug_idx" ON "network" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "network_grant_uniq_idx" ON "network_grant" USING btree ("network_id","organization_id","aggregate");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_slug_idx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_network_idx" ON "organization" USING btree ("network_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_idx" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_user_idx" ON "session" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technician_org_idx" ON "technician" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_idx" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_org_idx" ON "contact" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_org_idx" ON "customer" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_name_idx" ON "customer" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_email_idx" ON "customer" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_source_idx" ON "customer" USING btree ("organization_id","source_system","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_property_customer_idx" ON "customer_property" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_property_property_idx" ON "customer_property" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_property_idx" ON "equipment" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_serial_idx" ON "equipment" USING btree ("organization_id","serial_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_parent_idx" ON "equipment" USING btree ("parent_equipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_tag_idx" ON "equipment" USING btree ("organization_id","property_id","tag");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_org_idx" ON "property" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "property_addr_idx" ON "property" USING btree ("organization_id","postal_code","address_line1");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_book_category_org_idx" ON "price_book_category" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_item_code_idx" ON "price_book_item" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_item_version_idx" ON "price_book_item_version" USING btree ("item_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_book_item_version_current_idx" ON "price_book_item_version" USING btree ("organization_id","item_id","effective_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_hours_org_idx" ON "business_hours" USING btree ("organization_id","day_of_week");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crew_org_idx" ON "crew" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crew_member_uniq_idx" ON "crew_member" USING btree ("crew_id","technician_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "on_call_org_idx" ON "on_call_rotation" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rentable_asset_org_idx" ON "rentable_asset" USING btree ("organization_id","asset_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rentable_asset_identifier_idx" ON "rentable_asset" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_asset_idx" ON "rental" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rental_open_idx" ON "rental" USING btree ("organization_id","picked_up_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_org_idx" ON "route" USING btree ("organization_id","day_of_week");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_stop_route_idx" ON "route_stop" USING btree ("route_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_stop_due_idx" ON "route_stop" USING btree ("organization_id","next_due_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "territory_org_idx" ON "territory" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_off_tech_idx" ON "time_off" USING btree ("technician_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_org_status_idx" ON "job" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_customer_idx" ON "job" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_property_idx" ON "job" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_number_idx" ON "job" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_type_org_idx" ON "job_type" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_job_idx" ON "visit" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_board_idx" ON "visit" USING btree ("organization_id","window_start","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_assignment_visit_idx" ON "visit_assignment" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_assignment_tech_idx" ON "visit_assignment" USING btree ("technician_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorization_job_idx" ON "authorization" USING btree ("job_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorization_open_idx" ON "authorization" USING btree ("organization_id","state","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_site_contract_idx" ON "contract_site" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_work_order_uniq_idx" ON "external_work_order" USING btree ("organization_id","source_system","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_work_order_push_idx" ON "external_work_order" USING btree ("organization_id","pending_push");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_delivery_invoice_idx" ON "invoice_delivery" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_party_job_idx" ON "job_party" USING btree ("job_id","role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_party_customer_idx" ON "job_party" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obligation_due_idx" ON "obligation" USING btree ("organization_id","state","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obligation_entity_idx" ON "obligation" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_card_org_idx" ON "rate_card" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_card_line_card_idx" ON "rate_card_line" USING btree ("rate_card_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_contract_org_idx" ON "service_contract" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entitlement_visit_idx" ON "entitlement" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entitlement_job_idx" ON "entitlement" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entitlement_source_idx" ON "entitlement" USING btree ("organization_id","source","resolved_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_move_equipment_idx" ON "equipment_move" USING btree ("equipment_id","moved_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_asset_visit_idx" ON "visit_asset" USING btree ("visit_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_asset_equipment_idx" ON "visit_asset" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deficiency_backlog_idx" ON "deficiency" USING btree ("organization_id","status","severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deficiency_property_idx" ON "deficiency" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deficiency_due_idx" ON "deficiency" USING btree ("organization_id","correct_by_on","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_customer_idx" ON "delivery" USING btree ("organization_id","customer_id","delivered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_forecast_idx" ON "delivery" USING btree ("organization_id","equipment_id","delivered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_due_idx" ON "inspection" USING btree ("organization_id","next_due_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_property_idx" ON "inspection" USING btree ("property_id","performed_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_submission_idx" ON "inspection" USING btree ("organization_id","submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_program_org_idx" ON "inspection_program" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regulatory_constant_lookup_idx" ON "regulatory_constant" USING btree ("key","jurisdiction","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regulatory_submission_due_idx" ON "regulatory_submission" USING btree ("organization_id","state","due_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regulatory_submission_kind_idx" ON "regulatory_submission" USING btree ("organization_id","kind","period_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "retention_policy_org_idx" ON "retention_policy" USING btree ("organization_id","entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_block_layout_idx" ON "portal_block" USING btree ("layout_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_layout_org_idx" ON "portal_layout" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_report_visit_idx" ON "service_report" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_report_portal_idx" ON "service_report" USING btree ("organization_id","property_id","published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_report_field_report_idx" ON "service_report_field" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_report_field_trend_idx" ON "service_report_field" USING btree ("organization_id","property_id","key","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_report_field_regulatory_idx" ON "service_report_field" USING btree ("organization_id","epa_registration_number","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_report_template_org_idx" ON "service_report_template" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_org_idx" ON "estimate" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_customer_idx" ON "estimate" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_option_estimate_idx" ON "estimate_option" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_aging_idx" ON "invoice" USING btree ("organization_id","status","due_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_payer_idx" ON "invoice" USING btree ("organization_id","payer_customer_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_customer_idx" ON "invoice" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_job_idx" ON "invoice" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_line_invoice_idx" ON "invoice_line" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entry_tx_idx" ON "ledger_entry" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entry_org_time_idx" ON "ledger_entry" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entry_account_idx" ON "ledger_entry" USING btree ("organization_id","account_code","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entry_job_idx" ON "ledger_entry" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entry_source_idx" ON "ledger_entry" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_org_idx" ON "payment" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_idempotency_idx" ON "payment" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_processor_idx" ON "payment" USING btree ("processor","processor_payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_allocation_payment_idx" ON "payment_allocation" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_allocation_invoice_idx" ON "payment_allocation" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeclock_tech_idx" ON "timeclock_entry" USING btree ("organization_id","technician_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeclock_job_idx" ON "timeclock_entry" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeclock_open_idx" ON "timeclock_entry" USING btree ("organization_id","ended_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeclock_payroll_idx" ON "timeclock_entry" USING btree ("organization_id","classification","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wage_scale_org_idx" ON "wage_scale" USING btree ("organization_id","authority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wage_scale_class_idx" ON "wage_scale" USING btree ("organization_id","classification","jurisdiction");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connection_uniq_idx" ON "integration_connection" USING btree ("organization_id","capability","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_connection_status_idx" ON "integration_connection" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_offer_external_idx" ON "lead_offer" USING btree ("connector_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_offer_open_idx" ON "lead_offer" USING btree ("organization_id","status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_offer_payout_idx" ON "lead_offer" USING btree ("organization_id","payout_reconciled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_source_connector_org_idx" ON "lead_source_connector" USING btree ("organization_id","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_run_connection_idx" ON "sync_run" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachment_entity_idx" ON "attachment" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_org_idx" ON "audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_field_definition_org_idx" ON "custom_field_definition" USING btree ("organization_id","entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_event_idem_idx" ON "integration_event" USING btree ("provider","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_event_retry_idx" ON "integration_event" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_event_org_idx" ON "integration_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_endpoint_org_idx" ON "webhook_endpoint" USING btree ("organization_id");