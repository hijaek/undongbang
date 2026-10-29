CREATE TABLE `sync_outbox` (
	`room_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`room_id`, `entity`, `entity_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_room_per_user` ON `members` (`user_id`) WHERE "members"."status"='active';