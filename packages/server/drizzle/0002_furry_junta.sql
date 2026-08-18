ALTER TABLE `comparisons` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `deployment_components` ADD `before_existed` integer;--> statement-breakpoint
ALTER TABLE `deployment_components` ADD `before_sha256` text;--> statement-breakpoint
ALTER TABLE `deployment_packages` ADD `destructive_mode` text DEFAULT 'post';--> statement-breakpoint
ALTER TABLE `deployments` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `target_org_id` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `diagnostics_json` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `rollback_of_deployment_id` text;