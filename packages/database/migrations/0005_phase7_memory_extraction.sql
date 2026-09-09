CREATE TABLE "memory_extraction_state" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_ingested_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_extraction_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_extraction_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_extraction_state_tenant_isolation" ON "memory_extraction_state" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);
