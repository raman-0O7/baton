CREATE TABLE "chunks" (
	"tenant_id" uuid NOT NULL,
	"chunk_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"work_thread_id" uuid,
	"source_session_id" uuid NOT NULL,
	"source_agent" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"file_paths" jsonb NOT NULL,
	"source_event_ids" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"token_estimate" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chunks_tenant_id_chunk_id_pk" PRIMARY KEY("tenant_id","chunk_id")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_tenant_project_thread_idx" ON "chunks" USING btree ("tenant_id","project_id","work_thread_id");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_kind_check" CHECK ("kind" IN ('message', 'tool_use', 'file_change', 'task', 'decision', 'error'));--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_agent_check" CHECK ("source_agent" IN ('claudecode', 'codex', 'opencode'));--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_token_estimate_check" CHECK ("token_estimate" >= 0);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED;--> statement-breakpoint
CREATE INDEX "chunks_search_vector_idx" ON "chunks" USING gin ("search_vector");--> statement-breakpoint
COMMENT ON TABLE "chunks" IS 'Deterministic, source-linked retrieval units derived from immutable events; text is scrubbed evidence, never a raw native payload.';--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chunks_tenant_isolation" ON "chunks" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);