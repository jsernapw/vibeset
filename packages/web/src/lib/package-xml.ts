import type { ComponentKey } from '@vibeset/core';

/**
 * Client-side `package.xml` / `destructiveChangesPost.xml` preview for the
 * deployment review screen. The real artifact is built server-side via
 * SDR's `ComponentSet.getPackageXml()` (see the plan's Phase 1 package
 * generation section); this mirrors that same grouped-by-type shape purely
 * for a readable preview before a package actually exists.
 */
export function buildPackageXmlPreview(components: readonly ComponentKey[], apiVersion = '61.0'): string {
  const byType = new Map<string, string[]>();
  for (const c of components) {
    const list = byType.get(c.type);
    if (list) list.push(c.fullName);
    else byType.set(c.type, [c.fullName]);
  }
  const types = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const body = types
    .map(
      ([type, names]) =>
        `  <types>\n${names
          .sort()
          .map((n) => `    <members>${escapeXml(n)}</members>`)
          .join('\n')}\n    <name>${type}</name>\n  </types>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n  <version>${apiVersion}</version>\n</Package>`;
}

export function buildDestructiveChangesXml(components: readonly ComponentKey[]): string {
  if (components.length === 0) return '';
  return buildPackageXmlPreview(components).replace('<Package ', '<Package ');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
