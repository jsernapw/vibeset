import type { TestLevel } from '@vibeset/core';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TEST_LEVELS: { value: TestLevel; label: string; description: string }[] = [
  { value: 'NoTestRun', label: 'No test run', description: 'Only allowed for sandbox/scratch targets.' },
  {
    value: 'RunSpecifiedTests',
    label: 'Run specified tests',
    description:
      'Coverage is checked per deployed class (75% each) instead of org-wide — the way past a low org-wide average.',
  },
  {
    value: 'RunLocalTests',
    label: 'Run local tests',
    description:
      'All tests in this org, excluding managed packages. Coverage is averaged across EVERY local class, so untested code elsewhere can fail the deploy.',
  },
  { value: 'RunAllTestsInOrg', label: 'Run all tests in org', description: 'Every test in the org, including managed packages.' },
];

/**
 * `RunSpecifiedTests` is the only level that takes a test list, and the
 * Metadata API rejects it outright when the list is empty — so the input is
 * shown (and required) exactly for that level.
 *
 * It also behaves differently in a way worth surfacing: for the other levels
 * a production-like org (which includes Developer Edition orgs, not just real
 * production) enforces a 75% average across all local Apex. `RunSpecifiedTests`
 * instead requires 75% on each class in the deployment, which is what lets a
 * well-tested change land in an org whose overall coverage is poor.
 */
export function TestLevelPicker({
  value,
  onChange,
  runTests = [],
  onChangeRunTests,
}: {
  value: TestLevel;
  onChange: (level: TestLevel) => void;
  runTests?: string[];
  onChangeRunTests?: (tests: string[]) => void;
}) {
  const active = TEST_LEVELS.find((t) => t.value === value);
  const needsTests = value === 'RunSpecifiedTests';

  return (
    <div className="flex flex-col gap-1.5">
      <Label>Test level</Label>
      <Select value={value} onValueChange={(v) => onChange(v as TestLevel)}>
        <SelectTrigger className="max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TEST_LEVELS.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active && <p className="text-xs text-neutral-400">{active.description}</p>}

      {needsTests && onChangeRunTests && (
        <div className="mt-2 flex flex-col gap-1.5">
          <Label htmlFor="run-tests">Test classes to run</Label>
          <Input
            id="run-tests"
            value={runTests.join(', ')}
            placeholder="OrderHandlerTest, AccountServiceTest"
            onChange={(e) =>
              onChangeRunTests(
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
          <p className="text-xs text-neutral-400">
            Comma-separated Apex test class names. Every class you are deploying must reach 75% coverage from these
            tests.
          </p>
          {runTests.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Name at least one test class — Salesforce rejects this test level with an empty list.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
