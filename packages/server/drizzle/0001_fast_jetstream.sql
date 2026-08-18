CREATE TABLE `component_snapshot_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`org_id` text,
	`type` text NOT NULL,
	`full_name` text NOT NULL,
	`parent_full_name` text,
	`last_modified_date` text NOT NULL,
	`sha256` text NOT NULL,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`sha256`) REFERENCES `component_snapshots`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `component_snapshot_refs_lookup_idx` ON `component_snapshot_refs` (`source_id`,`type`,`full_name`,`last_modified_date`);