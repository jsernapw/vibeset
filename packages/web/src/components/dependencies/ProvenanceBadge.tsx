import type { DependencyEdge } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const SUPPLEMENT_LABEL: Record<NonNullable<DependencyEdge['supplementKind']>, string> = {
  'profile-grant': 'Profile grant',
  'permission-set-grant': 'Permission set grant',
  'layout-field-reference': 'Layout field reference',
};

/**
 * Renders one edge's provenance as a small, unambiguous badge — the UI
 * half of the "provenance must be visible" requirement (see
 * `@vibeset/core`'s `DependencyEdge` doc comment): `'org'` came straight
 * from the Tooling API's own `MetadataComponentDependency` (authoritative
 * for existence, never for absence); `'supplemented'` is VibeSet's own
 * Profile/PermissionSet/Layout backfill for a documented Tooling API gap
 * (`KNOWN_COVERAGE_GAPS`). Never collapsed into one undifferentiated
 * "dependency" label.
 */
export function ProvenanceBadge({ provenance, supplementKind }: { readonly provenance: DependencyEdge['provenance']; readonly supplementKind?: DependencyEdge['supplementKind'] }) {
  if (provenance === 'org') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="info">Org</Badge>
        </TooltipTrigger>
        <TooltipContent>Reported directly by Salesforce&apos;s Tooling API (MetadataComponentDependency).</TooltipContent>
      </Tooltip>
    );
  }
  const label = supplementKind ? SUPPLEMENT_LABEL[supplementKind] : 'Supplemented';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning">Supplemented</Badge>
      </TooltipTrigger>
      <TooltipContent>
        VibeSet-derived from {label.toLowerCase()} — backfills a documented Tooling API gap, not something Salesforce&apos;s own graph reported.
      </TooltipContent>
    </Tooltip>
  );
}
