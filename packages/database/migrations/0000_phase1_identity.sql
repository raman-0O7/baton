CREATE TABLE "access_tokens" (
	"token_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"audit_event_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"actor_user_id" uuid,
	"actor_device_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"request_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"session_hash" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"grant_id" uuid PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"device_name" text NOT NULL,
	"platform" text NOT NULL,
	"client_version" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"status" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"last_polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_user_id" uuid,
	"approved_tenant_id" uuid,
	"consumed_device_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"client_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"token_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenant_memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_families" (
	"family_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"primary_tenant_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_family_id_token_families_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."token_families"("family_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_family_id_token_families_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."token_families"("family_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_primary_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("primary_tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_tokens_family_idx" ON "access_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "access_tokens_expiry_idx" ON "access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_time_idx" ON "audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_request_idx" ON "audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "browser_sessions_tenant_user_idx" ON "browser_sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "browser_sessions_expiry_idx" ON "browser_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_device_code_uidx" ON "device_authorizations" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_user_code_uidx" ON "device_authorizations" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "device_authorizations_expiry_idx" ON "device_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_tenant_device_uidx" ON "devices" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE INDEX "devices_tenant_user_idx" ON "devices" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expiry_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "token_families_tenant_device_idx" ON "token_families" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_issuer_subject_uidx" ON "users" USING btree ("issuer","subject");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_kind_check" CHECK ("kind" IN ('personal', 'organization'));--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_role_check" CHECK ("role" IN ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_status_check" CHECK ("status" IN ('pending', 'approved', 'denied', 'consumed'));--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_interval_check" CHECK ("interval_seconds" BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "devices_tenant_isolation" ON "devices"
  USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events"
  USING ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('baton.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "access_tokens" IS 'Identity bootstrap table; access requires opaque token ID plus constant-time hash validation.';--> statement-breakpoint
COMMENT ON TABLE "refresh_tokens" IS 'Identity bootstrap table; refresh rotation and replay revocation run in a serializable transaction.';--> statement-breakpoint
COMMENT ON TABLE "browser_sessions" IS 'Identity bootstrap table; session secrets are stored only as HMAC hashes.';
