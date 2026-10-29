CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_room` ON `audit` (`room_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cheers` (
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`post_id`, `user_id`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comments_post` ON `comments` (`post_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `distributions` (
	`id` text PRIMARY KEY NOT NULL,
	`settlement_id` text NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`paid_at` text,
	FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `distribution_member` ON `distributions` (`settlement_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `fines` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`week` text NOT NULL,
	`count` integer NOT NULL,
	`exempt` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`paid_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fine_member_week` ON `fines` (`member_id`,`week`);--> statement-breakpoint
CREATE INDEX `fine_room_week` ON `fines` (`room_id`,`week`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` text NOT NULL,
	`left_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `members_room` ON `members` (`room_id`,`status`);--> statement-breakpoint
CREATE INDEX `members_user` ON `members` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `oauth` (
	`state` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`verifier` text NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text,
	`room_id` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`media_key` text NOT NULL,
	`thumb_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	`week` text NOT NULL,
	`status` text DEFAULT 'valid' NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `feed_cursor` ON `posts` (`room_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `member_week` ON `posts` (`member_id`,`week`,`status`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rests` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`week` text NOT NULL,
	`reason` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`decided_by` text,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rest_member_week` ON `rests` (`member_id`,`week`);--> statement-breakpoint
CREATE INDEX `rest_room` ON `rests` (`room_id`,`week`,`status`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host_id` text NOT NULL,
	`goal` integer NOT NULL,
	`fine_cents` integer NOT NULL,
	`timezone` text NOT NULL,
	`payout_period` text DEFAULT 'year' NOT NULL,
	`invite_code` text NOT NULL,
	`created_at` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`sheet_id` text,
	`sheet_url` text,
	`sheet_token` text,
	`sync_version` integer DEFAULT 0 NOT NULL,
	`synced_version` integer DEFAULT 0 NOT NULL,
	`sync_at` text,
	`sync_error` text,
	`sync_lease` text,
	`sync_lease_until` integer DEFAULT 0 NOT NULL,
	`close_through` text,
	`carry_cents` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_invite_code_unique` ON `rooms` (`invite_code`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`month` text NOT NULL,
	`total_cents` integer NOT NULL,
	`recipients` integer NOT NULL,
	`per_person_cents` integer NOT NULL,
	`carry_cents` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_room_month` ON `settlements` (`room_id`,`month`);--> statement-breakpoint
CREATE TABLE `sync_rows` (
	`room_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`row_index` integer NOT NULL,
	PRIMARY KEY(`room_id`, `entity`, `entity_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_row_index` ON `sync_rows` (`room_id`,`entity`,`row_index`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`media_key` text NOT NULL,
	`thumb_key` text NOT NULL,
	`kind` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	`finalized` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);