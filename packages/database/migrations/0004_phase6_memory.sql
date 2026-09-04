CREATE TABLE "memories" (
	"tenant_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"candidate_id" uuid,
	"category" text NOT NULL,
	"claim" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"confidence_milli" integer NOT NULL,
	"status" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"evidence_event_ids" jsonb NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memories_tenant_id_memory_id_pk" PRIMARY KEY("tenant_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"category" text NOT NULL,
	"claim" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"confidence_milli" integer NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"provenance" jsonb NOT NULL,
	"evidence_event_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_candidates_tenant_id_candidate_id_pk" PRIMARY KEY("tenant_id","candidate_id")
);
--> statement-breakpoint
CREATE INDEX "memories_tenant_scope_idx" ON "memories" USING btree ("tenant_id","status","scope_type");--> statement-breakpoint
CREATE INDEX "memory_candidates_tenant_status_idx" ON "memory_candidates" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_scope_check" CHECK ("scope_type" IN ('global', 'organization', 'project', 'work_thread'));--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_status_check" CHECK ("status" IN ('proposed', 'approved', 'rejected', 'revoked', 'expired', 'needs_review'));--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_confidence_check" CHECK ("confidence_milli" BETWEEN 0 AND 1000);--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_scope_check" CHECK ("scope_type" IN ('global', 'organization', 'project', 'work_thread'));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_status_check" CHECK ("status" IN ('proposed', 'approved', 'rejected', 'revoked', 'expired', 'needs_review'));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_confidence_check" CHECK ("confidence_milli" BETWEEN 0 AND 1000);--> statement-breakpoint
COMMENT ON TABLE "memory_candidates" IS 'Proposed personal memories awaiting review; nothing here reaches an agent until approved.';--> statement-breakpoint
COMMENT ON TABLE "memories" IS 'Approved, evidence-backed personal memories; SOUL.md is a rendering, never the source of truth.';--> statement-breakpoint
ALTER TABLE "memory_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_candidates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_candidates_tenant_isolation" ON "memory_candidates" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memories_tenant_isolation" ON "memories" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);