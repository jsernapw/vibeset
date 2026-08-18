import { describe, expect, it } from 'vitest';
import type { FileResponse, MetadataApiDeployStatus } from '@salesforce/source-deploy-retrieve';
import {
  componentResultLine,
  deployStatusSummaryMessage,
  mapDeployStatus,
  normalizeDeployDiagnostics,
  normalizeFileResponses,
  normalizeTestResults,
  percentFromDeployStatus,
} from '../../src/deploy/normalize.js';

describe('normalizeFileResponses', () => {
  it('maps a successful, changed component', () => {
    const responses: FileResponse[] = [
      { fullName: 'Foo', type: 'ApexClass', filePath: 'classes/Foo.cls', state: 'Changed' as never },
    ];
    const [result] = normalizeFileResponses(responses);
    expect(result).toEqual({ key: { type: 'ApexClass', fullName: 'Foo' }, status: 'succeeded', changed: true });
  });

  it('maps an unchanged component (state "Unchanged") with changed: false', () => {
    const responses: FileResponse[] = [
      { fullName: 'Foo', type: 'ApexClass', filePath: 'classes/Foo.cls', state: 'Unchanged' as never },
    ];
    const [result] = normalizeFileResponses(responses);
    expect(result.status).toBe('succeeded');
    expect(result.changed).toBe(false);
  });

  it('maps a failed component with line/column/problem text', () => {
    const responses: FileResponse[] = [
      {
        fullName: 'Foo',
        type: 'ApexClass',
        state: 'Failed' as never,
        error: 'Invalid type: Bar',
        lineNumber: 12,
        columnNumber: 4,
        problemType: 'Error',
      } as FileResponse,
    ];
    const [result] = normalizeFileResponses(responses);
    expect(result).toEqual({
      key: { type: 'ApexClass', fullName: 'Foo' },
      status: 'failed',
      changed: false,
      errorMessage: 'Invalid type: Bar',
      lineNumber: 12,
      columnNumber: 4,
    });
  });
});

describe('normalizeTestResults', () => {
  it('returns undefined when there is no runTestResult (e.g. NoTestRun)', () => {
    expect(normalizeTestResults(undefined)).toBeUndefined();
  });

  it('parses run/failure counts and computes aggregate coverage percent across multiple classes', () => {
    const result = normalizeTestResults({
      numTestsRun: '10',
      numFailures: '1',
      totalTime: '5.0',
      codeCoverage: [
        { id: '1', name: 'A', numLocations: '100', numLocationsNotCovered: '20', type: 'Class' },
        { id: '2', name: 'B', numLocations: '100', numLocationsNotCovered: '0', type: 'Class' },
      ],
    });
    expect(result).toEqual({ numberRun: 10, numberFailures: 1, coveragePercent: 90 });
  });

  it('leaves coveragePercent undefined when there is no coverage data at all (e.g. NoTestRun with an empty result)', () => {
    const result = normalizeTestResults({ numTestsRun: '0', numFailures: '0', totalTime: '0' });
    expect(result).toEqual({ numberRun: 0, numberFailures: 0, coveragePercent: undefined });
  });

  it('handles a single CodeCoverage object (not wrapped in an array) the same as an array of one', () => {
    const result = normalizeTestResults({
      numTestsRun: '1',
      numFailures: '0',
      totalTime: '1',
      codeCoverage: { id: '1', name: 'A', numLocations: '10', numLocationsNotCovered: '5', type: 'Class' },
    });
    expect(result?.coveragePercent).toBe(50);
  });
});

describe('normalizeDeployDiagnostics', () => {
  it('extracts test failures, coverage warnings, and component failures from a raw status', () => {
    const status = {
      details: {
        componentFailures: [
          { fullName: 'Foo', componentType: 'ApexClass', problem: 'Compile error', lineNumber: '3', columnNumber: '1' } as never,
        ],
        runTestResult: {
          numTestsRun: '2',
          numFailures: '1',
          totalTime: '1',
          failures: [
            { id: '1', name: 'FooTest', methodName: 'testBar', message: 'Assertion failed', packageName: '', stackTrace: 'at line 1', time: '1' },
          ],
          codeCoverageWarnings: [{ id: '1', message: 'Trigger has no coverage', namespace: '' }],
        },
      },
    } as unknown as MetadataApiDeployStatus;

    const diagnostics = normalizeDeployDiagnostics(status);
    expect(diagnostics.componentFailures).toEqual([
      { type: 'ApexClass', fullName: 'Foo', problem: 'Compile error', lineNumber: 3, columnNumber: 1 },
    ]);
    expect(diagnostics.testFailures).toEqual([
      { className: 'FooTest', methodName: 'testBar', message: 'Assertion failed', stackTrace: 'at line 1' },
    ]);
    expect(diagnostics.coverageWarnings).toEqual([{ name: '1', message: 'Trigger has no coverage' }]);
  });

  it('returns empty arrays (not throws) when there are no diagnostics at all', () => {
    const status = { details: {} } as unknown as MetadataApiDeployStatus;
    expect(normalizeDeployDiagnostics(status)).toEqual({ testFailures: [], coverageWarnings: [], componentFailures: [] });
  });
});

describe('mapDeployStatus', () => {
  it('maps done+success to succeeded', () => {
    expect(mapDeployStatus({ done: true, success: true, status: 'Succeeded' } as MetadataApiDeployStatus)).toBe('succeeded');
  });
  it('maps done+!success to failed', () => {
    expect(mapDeployStatus({ done: true, success: false, status: 'Failed' } as MetadataApiDeployStatus)).toBe('failed');
  });
  it('maps not-done to in-progress', () => {
    expect(mapDeployStatus({ done: false, success: false, status: 'InProgress' } as MetadataApiDeployStatus)).toBe('in-progress');
  });
  it('maps Canceled/Canceling to canceled regardless of done/success', () => {
    expect(mapDeployStatus({ done: true, success: false, status: 'Canceled' } as MetadataApiDeployStatus)).toBe('canceled');
    expect(mapDeployStatus({ done: false, success: false, status: 'Canceling' } as MetadataApiDeployStatus)).toBe('canceled');
  });
});

describe('percentFromDeployStatus / deployStatusSummaryMessage / componentResultLine', () => {
  it('computes a percent from deployed/total, capped at 99', () => {
    expect(percentFromDeployStatus({ numberComponentsDeployed: 5, numberComponentsTotal: 10 } as MetadataApiDeployStatus)).toBe(50);
    expect(percentFromDeployStatus({ numberComponentsDeployed: 10, numberComponentsTotal: 10 } as MetadataApiDeployStatus)).toBe(99);
  });
  it('falls back to 50 when total is 0 (not yet known)', () => {
    expect(percentFromDeployStatus({ numberComponentsDeployed: 0, numberComponentsTotal: 0 } as MetadataApiDeployStatus)).toBe(50);
  });
  it('summary message includes deployed/total/error counts', () => {
    const msg = deployStatusSummaryMessage({ numberComponentsDeployed: 3, numberComponentsTotal: 10, numberComponentErrors: 1 } as MetadataApiDeployStatus);
    expect(msg).toContain('3/10');
    expect(msg).toContain('1 error');
  });
  it('component line reports FAILED with the error text for a failure', () => {
    const line = componentResultLine({ type: 'ApexClass', fullName: 'Foo', state: 'Failed', error: 'bad' } as unknown as FileResponse);
    expect(line).toContain('FAILED');
    expect(line).toContain('bad');
  });
});
