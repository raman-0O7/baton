CREATE TABLE "artifacts" (
	"tenant_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_event_id" uuid,
	"artifact_class" text NOT NULL,
	"object_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_count" integer NOT NULL,
	"media_type" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "artifacts_tenant_id_artifact_id_pk" PRIMARY KEY("tenant_id","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"tenant_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"disclosure_version" text NOT NULL,
	"disclosure_digest" text NOT NULL,
	"collection_policy" jsonb NOT NULL,
	"cloud_processing_acknowledged" boolean NOT NULL,
	"model_processing_acknowledged" boolean NOT NULL,
	"capture_surface" text NOT NULL,
	"historical_import" boolean NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "consent_records_tenant_id_consent_record_id_pk" PRIMARY KEY("tenant_id","consent_record_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_batches" (
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"project_id" uuid NOT NULL,
	"project_installation_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ingestion_batches_tenant_id_batch_id_pk" PRIMARY KEY("tenant_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_checkpoints" (
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_installation_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"acknowledged_cursor" text NOT NULL,
	"head_event_id" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ingestion_checkpoints_tenant_id_device_id_project_installation_id_source_session_id_pk" PRIMARY KEY("tenant_id","device_id","project_installation_id","source_session_id")
);
--> statement-breakpoint
CREATE TABLE "project_installations" (
	"tenant_id" uuid NOT NULL,
	"project_installation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_installations_tenant_id_project_installation_id_pk" PRIMARY KEY("tenant_id","project_installation_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"state" text NOT NULL,
	"collection_policy" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "projects_tenant_id_project_id_pk" PRIMARY KEY("tenant_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "source_events" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"work_thread_id" uuid,
	"source_agent" text NOT NULL,
	"source_device_id" uuid NOT NULL,
	"native_sequence" integer,
	"parent_event_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "source_sessions" (
	"tenant_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"native_session_hash" text NOT NULL,
	"parser_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_sessions_tenant_id_source_session_id_pk" PRIMARY KEY("tenant_id","source_session_id")
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_installation_fk" FOREIGN KEY ("tenant_id","project_installation_id") REFERENCES "public"."project_installations"("tenant_id","project_installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_checkpoints" ADD CONSTRAINT "ingestion_checkpoints_installation_fk" FOREIGN KEY ("tenant_id","project_installation_id") REFERENCES "public"."project_installations"("tenant_id","project_installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_installations" ADD CONSTRAINT "project_installations_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_installations" ADD CONSTRAINT "project_installations_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."devices"("tenant_id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_session_fk" FOREIGN KEY ("tenant_id","source_session_id") REFERENCES "public"."source_sessions"("tenant_id","source_session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sessions" ADD CONSTRAINT "source_sessions_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_object_key_uidx" ON "artifacts" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "artifacts_tenant_project_idx" ON "artifacts" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "consent_records_active_installation_idx" ON "consent_records" USING btree ("tenant_id","project_installation_id","revoked_at");--> statement-breakpoint
CREATE INDEX "ingestion_batches_tenant_session_idx" ON "ingestion_batches" USING btree ("tenant_id","source_session_id","created_at");--> statement-breakpoint
CREATE INDEX "ingestion_checkpoints_tenant_project_idx" ON "ingestion_checkpoints" USING btree ("tenant_id","project_id","updated_at");--> statement-breakpoint
CREATE INDEX "project_installations_tenant_project_idx" ON "project_installations" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "projects_tenant_updated_idx" ON "projects" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_events_tenant_idempotency_uidx" ON "source_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "source_events_tenant_session_sequence_idx" ON "source_events" USING btree ("tenant_id","source_session_id","native_sequence");--> statement-breakpoint
CREATE INDEX "source_events_tenant_parent_idx" ON "source_events" USING btree ("tenant_id","parent_event_id");--> statement-breakpoint
CREATE INDEX "source_sessions_tenant_project_idx" ON "source_sessions" USING btree ("tenant_id","project_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_state_check" CHECK ("state" IN ('enabled', 'paused', 'disabled'));--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_acknowledgements_check" CHECK ("cloud_processing_acknowledged" AND "model_processing_acknowledged");--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_capture_surface_check" CHECK ("capture_surface" IN ('cli', 'dashboard'));--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_disclosure_digest_check" CHECK ("disclosure_digest" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "source_sessions" ADD CONSTRAINT "source_sessions_agent_check" CHECK ("agent" IN ('claudecode', 'codex', 'opencode'));--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_agent_check" CHECK ("source_agent" IN ('claudecode', 'codex', 'opencode'));--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_schema_version_check" CHECK ("schema_version" = 1);--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_native_sequence_check" CHECK ("native_sequence" IS NULL OR "native_sequence" >= 0);--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_class_check" CHECK ("artifact_class" IN ('scrubbed_diff', 'scrubbed_tool_result'));--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_media_type_check" CHECK ("media_type" IN ('application/json', 'text/plain'));--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_lifecycle_check" CHECK ("lifecycle_state" IN ('quarantined', 'finalized', 'deleting'));--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_byte_count_check" CHECK ("byte_count" BETWEEN 1 AND 1048576);--> statement-breakpoint
COMMENT ON TABLE "source_events" IS 'Immutable normalized Baton events only; complete native agent payloads are prohibited by the public DTO.';--> statement-breakpoint
COMMENT ON TABLE "ingestion_batches" IS 'Tenant-scoped idempotency receipts; acknowledgement JSON never contains event bodies.';--> statement-breakpoint
COMMENT ON TABLE "artifacts" IS 'Metadata for quarantined or finalized allowlisted artifacts; arbitrary attachments and native sessions are forbidden.';--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "projects_tenant_isolation" ON "projects" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "project_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_installations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "project_installations_tenant_isolation" ON "project_installations" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "consent_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "consent_records_tenant_isolation" ON "consent_records" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "source_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_sessions_tenant_isolation" ON "source_sessions" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "source_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_events_tenant_isolation" ON "source_events" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ingestion_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingestion_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ingestion_batches_tenant_isolation" ON "ingestion_batches" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ingestion_checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingestion_checkpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ingestion_checkpoints_tenant_isolation" ON "ingestion_checkpoints" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "artifacts_tenant_isolation" ON "artifacts" USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);
