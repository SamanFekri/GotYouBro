CREATE TABLE `api_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_credentials_token_hash_unique` ON `api_credentials` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_credentials_service_idx` ON `api_credentials` (`service_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`metadata` text,
	`ip` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`user_id` text NOT NULL,
	`destination_id` text,
	`destination_name` text,
	`filename` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text DEFAULT 'RECEIVED' NOT NULL,
	`error_code` text,
	`error_message` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backups_idempotency_idx` ON `backups` (`service_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `backups_user_created_idx` ON `backups` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `backups_service_created_idx` ON `backups` (`service_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`telegram_chat_id` integer NOT NULL,
	`telegram_thread_id` integer,
	`verified` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `destinations_user_idx` ON `destinations` (`user_id`);--> statement-breakpoint
CREATE TABLE `health_events` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`event_type` text DEFAULT 'OUTAGE' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_seconds` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `health_events_service_idx` ON `health_events` (`service_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`api_enabled` integer DEFAULT true NOT NULL,
	`destination_id` text,
	`health_enabled` integer DEFAULT false NOT NULL,
	`health_notify` integer DEFAULT true NOT NULL,
	`health_status` text DEFAULT 'UNKNOWN' NOT NULL,
	`health_interval_seconds` integer DEFAULT 60 NOT NULL,
	`health_grace_seconds` integer DEFAULT 60 NOT NULL,
	`last_heartbeat_at` integer,
	`went_down_at` integer,
	`last_recovered_at` integer,
	`total_downtime_seconds` integer DEFAULT 0 NOT NULL,
	`down_count` integer DEFAULT 0 NOT NULL,
	`last_backup_at` integer,
	`backup_count` integer DEFAULT 0 NOT NULL,
	`max_backup_size_mb` integer,
	`api_rate_limit` text,
	`backup_rate_limit` text,
	`heartbeat_rate_limit` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `services_user_idx` ON `services` (`user_id`);--> statement-breakpoint
CREATE INDEX `services_health_idx` ON `services` (`health_enabled`,`health_status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_id` integer NOT NULL,
	`username` text,
	`first_name` text,
	`last_name` text,
	`role` text DEFAULT 'USER' NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`blocked_reason` text,
	`notify_health` integer DEFAULT true NOT NULL,
	`notify_backup_failures` integer DEFAULT true NOT NULL,
	`max_services` integer,
	`max_backup_size_mb` integer,
	`api_rate_limit` text,
	`backup_rate_limit` text,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_telegram_id_unique` ON `users` (`telegram_id`);