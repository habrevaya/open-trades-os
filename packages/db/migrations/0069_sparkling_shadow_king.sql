CREATE TYPE "public"."price_change_kind" AS ENUM('change', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."escalation_target" AS ENUM('manager', 'role', 'person');--> statement-breakpoint
CREATE TYPE "public"."task_frequency" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_not_duplicate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_a_id" uuid NOT NULL,
	"customer_b_id" uuid NOT NULL,
	"reason" text,
	"decided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_change_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "price_change_kind" DEFAULT 'change' NOT NULL,
	"rule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text NOT NULL,
	"selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"reverses_batch_id" uuid,
	"reversed_by_batch_id" uuid,
	"applied_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_change_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"from_version_id" uuid NOT NULL,
	"to_version_id" uuid NOT NULL,
	"price_before" numeric(14, 4) NOT NULL,
	"price_after" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_checklist_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_escalation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"notified" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"reassigned_from_user_id" uuid,
	"reassigned_to_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_escalation_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"after_hours" integer NOT NULL,
	"minimum_priority" "task_priority",
	"target" "escalation_target" NOT NULL,
	"target_role" "member_role",
	"target_user_id" uuid,
	"reassign_to_user_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"assignee_user_id" uuid,
	"queue" text,
	"frequency" "task_frequency" NOT NULL,
	"weekday" integer,
	"month_day" integer,
	"due_minutes" integer DEFAULT 1020 NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_on" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_raised_on" date,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "reports_to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "checklist_override_reason" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "occurrence_on" date;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_not_duplicate" ADD CONSTRAINT "customer_not_duplicate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_not_duplicate" ADD CONSTRAINT "customer_not_duplicate_customer_a_id_customer_id_fk" FOREIGN KEY ("customer_a_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_not_duplicate" ADD CONSTRAINT "customer_not_duplicate_customer_b_id_customer_id_fk" FOREIGN KEY ("customer_b_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_not_duplicate" ADD CONSTRAINT "customer_not_duplicate_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_change_batch" ADD CONSTRAINT "price_change_batch_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_change_batch" ADD CONSTRAINT "price_change_batch_applied_by_user_id_user_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_change_line" ADD CONSTRAINT "price_change_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_change_line" ADD CONSTRAINT "price_change_line_batch_id_price_change_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."price_change_batch"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_change_line" ADD CONSTRAINT "price_change_line_item_id_price_book_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."price_book_item"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_change_line" ADD CONSTRAINT "price_change_line_from_version_id_price_book_item_version_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."price_book_item_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_change_line" ADD CONSTRAINT "price_change_line_to_version_id_price_book_item_version_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."price_book_item_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_checklist_item" ADD CONSTRAINT "task_checklist_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_checklist_item" ADD CONSTRAINT "task_checklist_item_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_checklist_item" ADD CONSTRAINT "task_checklist_item_done_by_user_id_user_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_escalation" ADD CONSTRAINT "task_escalation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_escalation" ADD CONSTRAINT "task_escalation_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_escalation" ADD CONSTRAINT "task_escalation_rule_id_task_escalation_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."task_escalation_rule"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_escalation_rule" ADD CONSTRAINT "task_escalation_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_escalation_rule" ADD CONSTRAINT "task_escalation_rule_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_escalation_rule" ADD CONSTRAINT "task_escalation_rule_reassign_to_user_id_user_id_fk" FOREIGN KEY ("reassign_to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_escalation_rule" ADD CONSTRAINT "task_escalation_rule_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_template" ADD CONSTRAINT "task_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_template" ADD CONSTRAINT "task_template_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_template" ADD CONSTRAINT "task_template_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_not_duplicate_pair_idx" ON "customer_not_duplicate" USING btree ("organization_id","customer_a_id","customer_b_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_not_duplicate_b_idx" ON "customer_not_duplicate" USING btree ("customer_b_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_change_batch_org_idx" ON "price_change_batch" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_change_line_batch_idx" ON "price_change_line" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_checklist_item_task_idx" ON "task_checklist_item" USING btree ("task_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_escalation_once_idx" ON "task_escalation" USING btree ("task_id","rule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_escalation_org_idx" ON "task_escalation" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_escalation_rule_org_idx" ON "task_escalation_rule" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_template_org_idx" ON "task_template" USING btree ("organization_id","active");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership" ADD CONSTRAINT "membership_reports_to_user_id_user_id_fk" FOREIGN KEY ("reports_to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task" ADD CONSTRAINT "task_template_id_task_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_template"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Categories that already share a name under one parent are folded together
-- before the index that forbids it. Applying a trade pack twice used to create
-- a second "Controls" beside the first, and an install carrying one would
-- otherwise fail this migration. The oldest of each set survives; items and
-- sub categories move onto it, and the rest are soft deleted rather than
-- removed. Repeated, because folding two parents can leave their children
-- sharing a name in turn.
DO $$
DECLARE
  folded integer;
  rounds integer := 0;
BEGIN
  LOOP
    WITH ranked AS (
      SELECT id,
             first_value(id) OVER (
               PARTITION BY organization_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)
               ORDER BY created_at, id
             ) AS keeper
      FROM "price_book_category"
      WHERE deleted_at IS NULL
    ), losers AS (
      SELECT id, keeper FROM ranked WHERE id <> keeper
    ), items AS (
      UPDATE "price_book_item" i SET category_id = l.keeper FROM losers l WHERE i.category_id = l.id
    ), children AS (
      UPDATE "price_book_category" c SET parent_id = l.keeper FROM losers l WHERE c.parent_id = l.id
    )
    UPDATE "price_book_category" c SET deleted_at = now(), updated_at = now()
    FROM losers l WHERE c.id = l.id;
    GET DIAGNOSTICS folded = ROW_COUNT;
    rounds := rounds + 1;
    EXIT WHEN folded = 0 OR rounds > 10;
  END LOOP;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_category_name_idx" ON "price_book_category" USING btree ("organization_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name")) WHERE "price_book_category"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_template_occurrence_idx" ON "task" USING btree ("organization_id","template_id","occurrence_on") WHERE "task"."template_id" is not null;