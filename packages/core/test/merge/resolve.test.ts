import { describe, expect, it } from 'vitest';
import {
  resolveThreeWay,
  resolveThreeWayCoverageAware,
  resolveTwoWay,
  resolveTwoWayCoverageAware,
} from '../../src/merge/resolve.js';

describe('resolveTwoWay — no common ancestor', () => {
  it('reports unchanged when neither side has the entry', () => {
    expect(resolveTwoWay(undefined, undefined)).toEqual({ status: 'unchanged', resolved: undefined });
  });

  it('reports unchanged when both sides agree', () => {
    expect(resolveTwoWay('A', 'A')).toEqual({ status: 'unchanged', resolved: 'A' });
  });

  it('cleanly takes left when only left has the entry — a non-overlapping change', () => {
    expect(resolveTwoWay('A', undefined)).toEqual({ status: 'take-left', resolved: 'A' });
  });

  it('cleanly takes right when only right has the entry', () => {
    expect(resolveTwoWay(undefined, 'B')).toEqual({ status: 'take-right', resolved: 'B' });
  });

  it('reports a conflict — never an auto-resolution — when both sides have DIFFERENT content, because there is no base to say who changed it', () => {
    const result = resolveTwoWay('A', 'B');
    expect(result.status).toBe('conflict');
    expect(result.resolved).toBeUndefined();
  });
});

describe('resolveThreeWay — base available', () => {
  it('reports unchanged when neither side touched the entry relative to base', () => {
    expect(resolveThreeWay('base', 'base', 'base')).toEqual({ status: 'unchanged', resolved: 'base' });
  });

  it('cleanly takes left when only left changed relative to base', () => {
    expect(resolveThreeWay('base', 'left-edit', 'base')).toEqual({
      status: 'take-left',
      resolved: 'left-edit',
    });
  });

  it('cleanly takes right when only right changed relative to base', () => {
    expect(resolveThreeWay('base', 'base', 'right-edit')).toEqual({
      status: 'take-right',
      resolved: 'right-edit',
    });
  });

  it('is not a conflict when both sides changed but converged on the identical final value', () => {
    expect(resolveThreeWay('base', 'same-edit', 'same-edit')).toEqual({
      status: 'unchanged',
      resolved: 'same-edit',
    });
  });

  it('is a genuine conflict only when BOTH sides changed to DIFFERENT values', () => {
    const result = resolveThreeWay('base', 'left-edit', 'right-edit');
    expect(result.status).toBe('conflict');
    expect(result.resolved).toBeUndefined();
  });

  it('treats a deletion as a change like any other, so delete-vs-edit is a conflict, not a silent delete or a silent keep', () => {
    const deleteVsEdit = resolveThreeWay('base', undefined, 'right-edit');
    expect(deleteVsEdit.status).toBe('conflict');
    const editVsDelete = resolveThreeWay('base', 'left-edit', undefined);
    expect(editVsDelete.status).toBe('conflict');
  });

  it('treats an addition (base never had the entry) the same as any other change', () => {
    expect(resolveThreeWay(undefined, 'added', undefined)).toEqual({
      status: 'take-left',
      resolved: 'added',
    });
    expect(resolveThreeWay(undefined, 'X', 'X')).toEqual({ status: 'unchanged', resolved: 'X' });
    expect(resolveThreeWay(undefined, 'X', 'Y').status).toBe('conflict');
  });

  it('resolves a both-sides-delete as a clean agreement, not a conflict', () => {
    expect(resolveThreeWay('base', undefined, undefined)).toEqual({
      status: 'unchanged',
      resolved: undefined,
    });
  });
});

describe('resolveTwoWayCoverageAware — the profile retrieve-pairing hazard', () => {
  it('behaves exactly like resolveTwoWay when both sides are confirmed (or present)', () => {
    expect(resolveTwoWayCoverageAware('A', 'B', true, true)).toEqual(resolveTwoWay('A', 'B'));
    expect(resolveTwoWayCoverageAware('A', undefined, true, true)).toEqual(resolveTwoWay('A', undefined));
  });

  it('degrades an ambiguous absence to unchanged rather than take-left/take-right/conflict', () => {
    // right is absent AND right's coverage never retrieved this ref — we
    // cannot tell whether right genuinely lacks it or simply never looked.
    const result = resolveTwoWayCoverageAware('A', undefined, true, false);
    expect(result).toEqual({ status: 'unchanged', resolved: 'A' });
  });

  it('degrades an ambiguous absence on the left side symmetrically', () => {
    const result = resolveTwoWayCoverageAware(undefined, 'B', false, true);
    expect(result).toEqual({ status: 'unchanged', resolved: 'B' });
  });

  it('never fabricates a decision when BOTH sides are ambiguous', () => {
    const result = resolveTwoWayCoverageAware(undefined, undefined, false, false);
    expect(result).toEqual({ status: 'unchanged', resolved: undefined });
  });
});

describe('resolveThreeWayCoverageAware — same hazard, with a base', () => {
  it('behaves exactly like resolveThreeWay when both sides are confirmed', () => {
    expect(resolveThreeWayCoverageAware('base', 'L', 'R', true, true)).toEqual(
      resolveThreeWay('base', 'L', 'R'),
    );
  });

  it('never treats an unconfirmed absence as evidence of a deletion — the central hazard', () => {
    // base has a value; left is absent but NOT confirmed (never retrieved);
    // right matches base. A naive 3-way merge would see left as "changed to
    // deleted" and confidently take-left, deploying a deletion of something
    // nobody actually touched.
    const result = resolveThreeWayCoverageAware('has-permission', undefined, 'has-permission', false, true);
    expect(result).toEqual({ status: 'unchanged', resolved: 'has-permission' });
  });

  it('still reports a genuine, confirmed deletion cleanly when the other side did not change it', () => {
    const result = resolveThreeWayCoverageAware('has-permission', undefined, 'has-permission', true, true);
    expect(result).toEqual({ status: 'take-left', resolved: undefined });
  });

  it('an unconfirmed absence on one side does not block a confirmed, real change on the other from being applied', () => {
    const result = resolveThreeWayCoverageAware('base', undefined, 'right-edit', false, true);
    expect(result).toEqual({ status: 'take-right', resolved: 'right-edit' });
  });
});
