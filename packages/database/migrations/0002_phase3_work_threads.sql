CREATE TABLE "work_thread_sessions" (
	"tenant_id" uuid NOT NULL,
	"work_thread_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"assignment" text NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_thread_sessions_tenant_id_work_thread_id_source_session_id_pk" PRIMARY KEY("tenant_id","work_thread_id","source_session_id")
);
--> statement-breakpoint
CREATE TABLE "work_threads" (
	"tenant_id" uuid NOT NULL,
	"work_thread_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"goal" text,
	"state" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_threads_tenant_id_work_thread_id_pk" PRIMARY KEY("tenant_id","work_thread_id")
);
--> statement-breakpoint
ALTER TABLE "work_thread_sessions" ADD CONSTRAINT "work_thread_sessions_thread_fk" FOREIGN KEY ("tenant_id","work_thread_id") REFERENCES "public"."work_threads"("tenant_id","work_thread_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_thread_sessions" ADD CONSTRAINT "work_thread_sessions_session_fk" FOREIGN KEY ("tenant_id","source_session_id") REFERENCES "public"."source_sessions"("tenant_id","source_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_threads" ADD CONSTRAINT "work_threads_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_thread_sessions_tenant_session_uidx" ON "work_thread_sessions" USING btree ("tenant_id","source_session_id");--> statement-breakpoint
CREATE INDEX "work_threads_tenant_project_idx" ON "work_threads" USING btree ("tenant_id","project_id","updated_at");--> statement-breakpoint
ALTER TABLE "work_threads" ADD CONSTRAINT "work_threads_state_check" CHECK ("state" IN ('active', 'paused', 'completed', 'archived'));--> statement-breakpoint
ALTER TABLE "work_thread_sessions" ADD CONSTRAINT "work_thread_sessions_assignment_check" CHECK ("assignment" IN ('suggested', 'confirmed'));--> statement-breakpoint
ALTER TABLE "work_thread_sessions" ADD CONSTRAINT "work_thread_sessions_position_check" CHECK ("position" >= 0);--> statement-breakpoint
COMMENT ON TABLE "work_threads" IS 'User-facing goals that may span multiple source sessions, agents, and devices; state is materialized from immutable events.';--> statement-breakpoint
COMMENT ON TABLE "work_thread_sessions" IS 'Joins source sessions to a work thread; a source session belongs to at most one thread (unique per tenant).';--> statement-breakpoint
ALTER TABLE "work_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "work_threads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "work_threads_tenant_isolation" ON "work_threads" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "work_thread_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "work_thread_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "work_thread_sessions_tenant_isolation" ON "work_thread_sessions" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);