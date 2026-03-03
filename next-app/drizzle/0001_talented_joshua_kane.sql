CREATE TABLE "machine" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"deviceId" text NOT NULL,
	"hostName" text,
	"runtimes" text[],
	"lastSeenAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_key" (
	"id" text PRIMARY KEY NOT NULL,
	"machineId" text NOT NULL,
	"keyPrefix" text NOT NULL,
	"keyHash" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "machine_session" (
	"id" text PRIMARY KEY NOT NULL,
	"machineId" text NOT NULL,
	"issuedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"revokedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_key" ADD CONSTRAINT "machine_key_machineId_machine_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."machine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_session" ADD CONSTRAINT "machine_session_machineId_machine_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."machine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_device_id_unique" ON "machine" USING btree ("deviceId");--> statement-breakpoint
CREATE INDEX "machine_user_id_idx" ON "machine" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "machine_key_machine_id_idx" ON "machine_key" USING btree ("machineId");--> statement-breakpoint
CREATE INDEX "machine_key_prefix_idx" ON "machine_key" USING btree ("keyPrefix");--> statement-breakpoint
CREATE INDEX "machine_session_machine_id_idx" ON "machine_session" USING btree ("machineId");