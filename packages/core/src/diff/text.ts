import { diffLines, type Change } from 'diff';
import type { TextDiffHunk } from '../types/diff.js';

/**
 * The text differ for opaque body types: Apex classes/triggers, LWC/Aura
 * JS/HTML/CSS, Visualforce. These have no natural-key schema to decompose
 * — they're just code — so this is a plain line diff (jsdiff), with line
 * numbers attached so the UI can render it in Monaco's `DiffEditor`
 * without recomputing offsets.
 */

function normalizeLineEndings(text: string): string {
  // Same rationale as normalize.ts: CRLF vs LF is a real, common source of
  // phantom diffs between Windows-authored source and org retrievals, and
  // carries no semantic meaning in any of these languages.
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function lineCountOf(change: Change): number {
  if (typeof change.count === 'number') return change.count;
  if (change.value === '') return 0;
  const parts = change.value.split('\n');
  // A trailing '\n' produces one empty trailing element that isn't a real line.
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/**
 * Diffs two text bodies. `lineStart` is the 1-based line number in the
 * left/before content where each hunk starts (per `TextDiffHunk`'s
 * contract) — for an added-only hunk (no left-side counterpart), this is
 * the insertion point: the line in `left` immediately after which the new
 * content appears.
 */
export function diffText(left: string | undefined, right: string | undefined): TextDiffHunk[] {
  const leftText = normalizeLineEndings(left ?? '');
  const rightText = normalizeLineEndings(right ?? '');
  const changes = diffLines(leftText, rightText);

  const hunks: TextDiffHunk[] = [];
  let leftLine = 1;
  for (const change of changes) {
    hunks.push({
      added: Boolean(change.added),
      removed: Boolean(change.removed),
      value: change.value,
      lineStart: leftLine,
    });
    if (!change.added) {
      leftLine += lineCountOf(change);
    }
  }
  return hunks;
}
