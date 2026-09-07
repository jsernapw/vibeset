CREATE TABLE `dependency_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`job_id` text,
	`org_edge_count` integer DEFAULT 0,
	`supplemented_edge_count` integer DEFAULT 0,
	`managed_package_edge_count` integer DEFAULT 0,
	`filter_json` text,
	`known_gaps_json` text,
	`errors_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP INDEX `dependency_edges_from_idx`;--> statement-breakpoint
ALTER TABLE `dependency_edges` ADD `sync_run_id` text;--> statement-breakpoint
ALTER TABLE `dependency_edges` ADD `authoritative` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_edges` ADD `from_namespace` text;--> statement-breakpoint
ALTER TABLE `dependency_edges` ADD `to_namespace` text;--> statement-breakpoint
CREATE INDEX `dependency_edges_to_idx` ON `dependency_edges` (`connection_id`,`to_type`,`to_full_name`);--> statement-breakpoint
CREATE INDEX `dependency_edges_from_idx` ON `dependency_edges` (`connection_id`,`from_type`,`from_full_name`);