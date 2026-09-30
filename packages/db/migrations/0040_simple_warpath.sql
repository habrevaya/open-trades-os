CREATE TYPE "public"."accounting_entity_kind" AS ENUM('customer', 'invoice', 'payment', 'credit_memo');--> statement-breakpoint
CREATE TYPE "public"."accounting_link_state" AS ENUM('pending', 'linked', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"external_id" text NOT NULL,
	"external_name" text NOT NULL,
	"external_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounting_entity_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" "accounting_entity_kind" NOT NULL,
	"entity_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "accounting_link_state" DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"external_version" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounting_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_user_id" uuid,
	"note" text,
	"reopened_at" timestamp with time zone,
	"reopened_by_user_id" uuid,
	"reopened_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sync_run" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_mapping" ADD CONSTRAINT "account_mapping_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_mapping" ADD CONSTRAINT "account_mapping_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_entity_link" ADD CONSTRAINT "accounting_entity_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_entity_link" ADD CONSTRAINT "accounting_entity_link_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounting_period" ADD CONSTRAINT "accounting_period_reopened_by_user_id_user_id_fk" FOREIGN KEY ("reopened_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_mapping_code_idx" ON "account_mapping" USING btree ("connection_id","account_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_mapping_org_idx" ON "account_mapping" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_entity_link_entity_idx" ON "accounting_entity_link" USING btree ("connection_id","kind","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_entity_link_external_idx" ON "accounting_entity_link" USING btree ("connection_id","kind","external_id") WHERE "accounting_entity_link"."external_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_entity_link_state_idx" ON "accounting_entity_link" USING btree ("organization_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_period_end_idx" ON "accounting_period" USING btree ("organization_id","period_end");