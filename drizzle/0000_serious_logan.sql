CREATE TABLE `message_review` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`processed_message_id` integer,
	`message` text NOT NULL,
	`bot_rating` real NOT NULL,
	`user_rating` real NOT NULL,
	`user_tg_id` text NOT NULL,
	`user_tg_name` text NOT NULL,
	`source_channel` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
--> statement-breakpoint
CREATE TABLE `monitored_channel` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_username` text NOT NULL,
	`display_name` text,
	`active` integer DEFAULT true,
	`added_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitored_channel_channel_username_unique` ON `monitored_channel` (`channel_username`);--> statement-breakpoint
CREATE TABLE `processed_message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`message_text` text,
	`relevance_score` real,
	`summary` text,
	`dispatched` integer DEFAULT false,
	`processed_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
--> statement-breakpoint
CREATE TABLE `subscriber` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`active` integer DEFAULT true,
	`subscribed_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriber_chat_id_unique` ON `subscriber` (`chat_id`);