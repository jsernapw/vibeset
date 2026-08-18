CREATE TABLE `analyzer_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`analyzer_id` text NOT NULL,
	`severity` text NOT NULL,
	`type` text NOT NULL,
	`full_name` text NOT NULL,
	`message` text NOT NULL,
	`path` text,
	`line` integer,
	`comparison_id` text,
	`deployment_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`comparison_id`) REFERENCES `comparisons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`left_connection_id` text,
	`right_connection_id` text,
	`filter_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`left_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`right_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `component_snapshots` (
	`sha256` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`full_name` text NOT NULL,
	`parent_full_name` text,
	`content` text NOT NULL,
	`size` integer NOT NULL,
	`first_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`username` text,
	`instance_url` text,
	`alias` text,
	`is_sandbox` integer,
	`api_version` text,
	`project_path` text,
	`expires_at` text,
	`metadata_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `dependency_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text,
	`from_type` text NOT NULL,
	`from_full_name` text NOT NULL,
	`to_type` text NOT NULL,
	`to_full_name` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dependency_edges_from_idx` ON `dependency_edges` (`from_type`,`from_full_name`);--> statement-breakpoint
CREATE TABLE `deployment_components` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`type` text NOT NULL,
	`full_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`changed` integer DEFAULT false,
	`error_message` text,
	`line_number` integer,
	`column_number` integer,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deployment_components_deployment_idx` ON `deployment_components` (`deployment_id`);--> statement-breakpoint
CREATE TABLE `deployment_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`comparison_id` text,
	`components_json` text NOT NULL,
	`destructive_components_json` text,
	`manifest_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`comparison_id`) REFERENCES `comparisons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text,
	`target_connection_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`check_only` integer DEFAULT false NOT NULL,
	`test_level` text,
	`validation_id` text,
	`number_component_errors` integer DEFAULT 0,
	`number_components_deployed` integer DEFAULT 0,
	`number_components_total` integer DEFAULT 0,
	`result_json` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `deployment_packages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `diff_results` (
	`id` text PRIMARY KEY NOT NULL,
	`comparison_id` text NOT NULL,
	`type` text NOT NULL,
	`full_name` text NOT NULL,
	`parent_full_name` text,
	`status` text NOT NULL,
	`left_sha256` text,
	`right_sha256` text,
	`entries_json` text,
	`text_diff_json` text,
	FOREIGN KEY (`comparison_id`) REFERENCES `comparisons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`left_sha256`) REFERENCES `component_snapshots`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`right_sha256`) REFERENCES `component_snapshots`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `diff_results_comparison_idx` ON `diff_results` (`comparison_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload_json` text,
	`result_json` text,
	`error` text,
	`error_stack` text,
	`progress_percent` integer DEFAULT 0,
	`progress_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text
);
