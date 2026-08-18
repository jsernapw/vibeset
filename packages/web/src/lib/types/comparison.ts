/**
 * Non-mock home for comparison-related data shapes shared across
 * `lib/adapters/**` and component files this workstream does not own
 * (`components/comparisons/ResultsToolbar.tsx`). Moved out of
 * `lib/mock/comparison-mock.ts` — see that file's doc comment — so nothing
 * "shared" lives in a module named after fabricated data anymore.
 */
export interface CacheStats {
  readonly totalComponents: number;
  readonly retrievedComponents: number;
  readonly cacheHits: number;
  readonly hitRatePercent: number;
}
