CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`status` text NOT NULL,
	`manifest_key` text,
	`rows` integer DEFAULT 0 NOT NULL,
	`objects` integer DEFAULT 0 NOT NULL,
	`verified_at` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`first_at` text NOT NULL,
	`last_at` text NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`resolved_at` text,
	`notified_at` text
);
--> statement-breakpoint
CREATE INDEX `incident_open` ON `incidents` (`resolved_at`,`last_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`last_started` text,
	`last_success` text,
	`last_error` text
);
