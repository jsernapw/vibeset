import { FileArchive } from 'lucide-react';
import type { DiffResult } from '@vibeset/core';
import { EmptyState } from '@/components/ui/empty-state';
import { useComponentContent } from '@/lib/adapters/comparisons';
import { formatBytes } from '@/lib/utils';

/**
 * `resolveComponentContents`/`encodeBinaryContent` in `@vibeset/core`
 * (`compare/content-reader.ts`, `util/binary-content.ts`) store a binary
 * component's body as `JSON.stringify({ bodyBase64, metaXml })` — decoding
 * just enough of that to report an honest byte size, without ever handing
 * the actual bytes to a text/Monaco renderer. Base64's exact byte count is
 * derivable from the encoded string length and its trailing `=` padding
 * without materializing a buffer client-side.
 */
function decodedByteLength(content: string | undefined): number | undefined {
  if (content === undefined) return undefined;
  let bodyBase64: string;
  try {
    const parsed = JSON.parse(content) as { bodyBase64?: string };
    bodyBase64 = parsed.bodyBase64 ?? '';
  } catch {
    return undefined;
  }
  if (bodyBase64.length === 0) return 0;
  const padding = bodyBase64.endsWith('==') ? 2 : bodyBase64.endsWith('=') ? 1 : 0;
  return Math.floor((bodyBase64.length * 3) / 4) - padding;
}

function summaryLine(status: DiffResult['status'], leftSize: number | undefined, rightSize: number | undefined): string {
  switch (status) {
    case 'new':
      return rightSize === undefined ? 'Binary file, added' : `Binary file, added — ${formatBytes(rightSize)}`;
    case 'deleted':
      return leftSize === undefined ? 'Binary file, removed' : `Binary file, removed — ${formatBytes(leftSize)}`;
    case 'changed':
      return leftSize === undefined || rightSize === undefined
        ? 'Binary file, changed'
        : `Binary file, changed — ${formatBytes(leftSize)} → ${formatBytes(rightSize)}`;
    case 'identical': {
      const size = rightSize ?? leftSize;
      return size === undefined ? 'Binary file, unchanged' : `Binary file, unchanged — ${formatBytes(size)}`;
    }
  }
}

/**
 * Renders `DiffResult.binary === true` components (StaticResource zips,
 * Documents): compared by content hash, not text, so there is no
 * meaningful line- or tree-diff to show. This is the honest alternative —
 * status, size(s), and the actual sha256(es) compared — instead of feeding
 * arbitrary bytes into `LazyMonacoDiff`, which would render garbage.
 */
export function BinaryDiffSummary({
  result,
  leftLabel,
  rightLabel,
  comparisonId,
}: {
  result: DiffResult;
  leftLabel: string;
  rightLabel: string;
  comparisonId: string | undefined;
}) {
  const content = useComponentContent(comparisonId, result.key);

  if (content.isPending) {
    return <EmptyState title="Loading binary metadata..." description={`Fetching ${result.key.fullName}'s stored size and hash.`} />;
  }
  if (content.isError) {
    return (
      <EmptyState
        title="Could not load binary metadata"
        description={content.error?.message ?? 'The component could not be resolved from the snapshot store.'}
      />
    );
  }

  const leftSize = decodedByteLength(content.data?.leftContent);
  const rightSize = decodedByteLength(content.data?.rightContent);
  const rows: { label: string; size: number | undefined; sha: string | undefined }[] = [
    { label: leftLabel, size: leftSize, sha: result.leftSha256 },
    { label: rightLabel, size: rightSize, sha: result.rightSha256 },
  ].filter((r) => r.size !== undefined || r.sha !== undefined);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center gap-3">
        <FileArchive className="h-8 w-8 shrink-0 text-neutral-300 dark:text-neutral-700" />
        <div>
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {summaryLine(result.status, leftSize, rightSize)}
          </p>
          <p className="text-xs text-neutral-400">
            Compared by content hash, not by line or structure — binary content has no meaningful text diff.
          </p>
        </div>
      </div>

      {rows.length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-neutral-100 text-left text-neutral-400 dark:border-neutral-900">
              <th className="pb-1.5 font-medium">Side</th>
              <th className="pb-1.5 font-medium">Size</th>
              <th className="pb-1.5 font-medium">sha256</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-neutral-50 last:border-0 dark:border-neutral-900/50">
                <td className="py-1.5 pr-3 font-medium text-neutral-600 dark:text-neutral-300">{row.label}</td>
                <td className="py-1.5 pr-3 text-neutral-500 dark:text-neutral-400">{row.size !== undefined ? formatBytes(row.size) : '—'}</td>
                <td className="py-1.5 font-mono text-[11px] text-neutral-400 selection:bg-neutral-200 dark:selection:bg-neutral-700">
                  {row.sha ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
