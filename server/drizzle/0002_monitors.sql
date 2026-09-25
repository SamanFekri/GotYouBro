-- Multiple health monitors per service. Each service's existing health settings become its
-- "default" monitor (kept only if it was used), and health history is re-linked to monitors.
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`notify` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'UNKNOWN' NOT NULL,
	`interval_seconds` integer DEFAULT 60 NOT NULL,
	`grace_seconds` integer DEFAULT 60 NOT NULL,
	`last_heartbeat_at` integer,
	`went_down_at` integer,
	`last_recovered_at` integer,
	`total_downtime_seconds` integer DEFAULT 0 NOT NULL,
	`down_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitors_service_key_idx` ON `monitors` (`service_id`,`key`);--> statement-breakpoint
CREATE INDEX `monitors_status_idx` ON `monitors` (`enabled`,`status`);--> statement-breakpoint
INSERT INTO `monitors` (`id`, `service_id`, `key`, `name`, `enabled`, `notify`, `status`, `interval_seconds`, `grace_seconds`,
  `last_heartbeat_at`, `went_down_at`, `last_recovered_at`, `total_downtime_seconds`, `down_count`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(8))), `id`, 'default', 'Default', `health_enabled`, `health_notify`, `health_status`,
  `health_interval_seconds`, `health_grace_seconds`, `last_heartbeat_at`, `went_down_at`, `last_recovered_at`,
  `total_downtime_seconds`, `down_count`, `created_at`, `updated_at`
FROM `services`
WHERE `health_enabled` = 1 OR `last_heartbeat_at` IS NOT NULL OR `down_count` > 0;--> statement-breakpoint
CREATE TABLE `__new_health_events` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	`event_type` text DEFAULT 'OUTAGE' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_seconds` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_health_events` (`id`, `service_id`, `monitor_id`, `event_type`, `started_at`, `ended_at`, `duration_seconds`)
SELECT e.`id`, e.`service_id`, m.`id`, e.`event_type`, e.`started_at`, e.`ended_at`, e.`duration_seconds`
FROM `health_events` e JOIN `monitors` m ON m.`service_id` = e.`service_id` AND m.`key` = 'default';--> statement-breakpoint
DROP TABLE `health_events`;--> statement-breakpoint
ALTER TABLE `__new_health_events` RENAME TO `health_events`;--> statement-breakpoint
CREATE INDEX `health_events_service_idx` ON `health_events` (`service_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `health_events_monitor_idx` ON `health_events` (`monitor_id`,`started_at`);--> statement-breakpoint
DROP INDEX `services_health_idx`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `health_enabled`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `health_notify`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `health_status`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `health_interval_seconds`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `health_grace_seconds`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `last_heartbeat_at`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `went_down_at`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `last_recovered_at`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `total_downtime_seconds`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `down_count`;
