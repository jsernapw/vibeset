ALTER TABLE `comparisons` ADD `profile_coverage_json` text;--> statement-breakpoint
ALTER TABLE `diff_results` ADD `binary` integer;--> statement-breakpoint
ALTER TABLE `diff_results` ADD `unreadable_json` text;