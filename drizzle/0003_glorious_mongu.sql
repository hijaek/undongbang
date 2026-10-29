ALTER TABLE `rooms` ADD `sync_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `sync_retry_at` integer DEFAULT 0 NOT NULL;