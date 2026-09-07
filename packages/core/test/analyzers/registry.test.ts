import { describe, expect, it } from 'vitest';
import { AnalyzerRegistry, runAnalyzers, sortFindings } from '../../src/analyzers/registry.js';
import type { Analyzer, AnalysisContext, Finding } from '../../src/types/analyzer.js';

function ctx(): AnalysisContext {
  return { packageComponents: [] };
}

function makeAnalyzer(id: string, overrides: Partial<Analyzer> = {}): Analyzer {
  return {
    id,
    title: id,
    category: 'stale',
    defaultSeverity: 'info',
    analyze: () => [],
    ...overrides,
  };
}

describe('AnalyzerRegistry', () => {
  it('rejects registering the same analyzer id twice', () => {
    const registry = new AnalyzerRegistry();
    registry.register(makeAnalyzer('dup/rule'));
    expect(() => registry.register(makeAnalyzer('dup/rule'))).toThrow(/already registered/);
  });

  it('list() returns every registered analyzer', () => {
    const registry = new AnalyzerRegistry();
    registry.registerAll([makeAnalyzer('a/1'), makeAnalyzer('a/2')]);
    expect(registry.list().map((a) => a.id)).toEqual(['a/1', 'a/2']);
  });

  it('get() finds an analyzer by id', () => {
    const registry = new AnalyzerRegistry();
    const rule = makeAnalyzer('a/1');
    registry.register(rule);
    expect(registry.get('a/1')).toBe(rule);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('run() skips an analyzer whose appliesTo returns false', () => {
    const registry = new AnalyzerRegistry();
    registry.register(
      makeAnalyzer('a/skip', {
        appliesTo: () => false,
        analyze: () => [
          { analyzerId: 'a/skip', severity: 'error', title: 't', detail: 'd', recommendation: 'r' },
        ],
      }),
    );
    expect(registry.run(ctx())).toEqual([]);
  });

  it('run() includes findings from an analyzer whose appliesTo returns true', () => {
    const registry = new AnalyzerRegistry();
    const finding: Finding = {
      analyzerId: 'a/run',
      severity: 'warning',
      title: 't',
      detail: 'd',
      recommendation: 'r',
    };
    registry.register(makeAnalyzer('a/run', { appliesTo: () => true, analyze: () => [finding] }));
    expect(registry.run(ctx())).toEqual([finding]);
  });

  it('run() respects disabledIds', () => {
    const registry = new AnalyzerRegistry();
    const finding: Finding = {
      analyzerId: 'a/on',
      severity: 'warning',
      title: 't',
      detail: 'd',
      recommendation: 'r',
    };
    registry.registerAll([
      makeAnalyzer('a/on', { analyze: () => [finding] }),
      makeAnalyzer('a/off', { analyze: () => [{ ...finding, analyzerId: 'a/off' }] }),
    ]);
    expect(registry.run(ctx(), { disabledIds: new Set(['a/off']) })).toEqual([finding]);
  });

  it('run() catches a throwing analyzer and reports it as an info finding without aborting other analyzers', () => {
    const registry = new AnalyzerRegistry();
    const goodFinding: Finding = {
      analyzerId: 'a/good',
      severity: 'error',
      title: 'good',
      detail: 'd',
      recommendation: 'r',
    };
    registry.registerAll([
      makeAnalyzer('a/bad', {
        analyze: () => {
          throw new Error('boom');
        },
      }),
      makeAnalyzer('a/good', { analyze: () => [goodFinding] }),
    ]);
    const results = registry.run(ctx());
    expect(results).toContainEqual(goodFinding);
    const errorFinding = results.find((f) => f.analyzerId === 'a/bad');
    expect(errorFinding?.severity).toBe('info');
    expect(errorFinding?.detail).toContain('boom');
  });

  it('runAnalyzers() is a stateless equivalent of registering then running', () => {
    const finding: Finding = {
      analyzerId: 'a/x',
      severity: 'info',
      title: 't',
      detail: 'd',
      recommendation: 'r',
    };
    const results = runAnalyzers([makeAnalyzer('a/x', { analyze: () => [finding] })], ctx());
    expect(results).toEqual([finding]);
  });
});

describe('sortFindings', () => {
  it('orders error before warning before info', () => {
    const findings: Finding[] = [
      { analyzerId: 'z', severity: 'info', title: 'i', detail: '', recommendation: '' },
      { analyzerId: 'z', severity: 'error', title: 'e', detail: '', recommendation: '' },
      { analyzerId: 'z', severity: 'warning', title: 'w', detail: '', recommendation: '' },
    ];
    expect(sortFindings(findings).map((f) => f.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('breaks ties by analyzerId then title, for a stable render order', () => {
    const findings: Finding[] = [
      { analyzerId: 'b/rule', severity: 'error', title: 'z', detail: '', recommendation: '' },
      { analyzerId: 'a/rule', severity: 'error', title: 'b', detail: '', recommendation: '' },
      { analyzerId: 'a/rule', severity: 'error', title: 'a', detail: '', recommendation: '' },
    ];
    expect(sortFindings(findings).map((f) => `${f.analyzerId}:${f.title}`)).toEqual([
      'a/rule:a',
      'a/rule:b',
      'b/rule:z',
    ]);
  });

  it('does not mutate the input array', () => {
    const findings: Finding[] = [
      { analyzerId: 'z', severity: 'info', title: 'i', detail: '', recommendation: '' },
      { analyzerId: 'z', severity: 'error', title: 'e', detail: '', recommendation: '' },
    ];
    const original = [...findings];
    sortFindings(findings);
    expect(findings).toEqual(original);
  });
});
