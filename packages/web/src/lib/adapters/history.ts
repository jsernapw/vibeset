import { useCallback, useState } from 'react';
import type { DeploymentRecord } from '@/lib/types/deployment';
import { trpc } from '@/lib/trpc';

/**
 * Adapter boundary for deployment history + rollback — now backed by
 * `packages/server`'s real `history.*` tRPC router. Re-exports the same
 * `deploy.ts` hooks for the list/detail views (both already query real
 * data — see that file's top-of-file doc comment for its one signature
 * nuance), and wires rollback-package generation to the real
 * `history.generateRollback` mutation.
 */
export { useDeployments as useHistoryList, useDeployment as useHistoryDetail } from './deploy';

export interface RollbackPackage {
  readonly id: string;
  readonly sourceDeploymentId: string;
  readonly manifestYaml: string;
  readonly componentCount: number;
  readonly createdAt: string;
}

export function useGenerateRollback() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<RollbackPackage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generateRollback = trpc.history.generateRollback.useMutation();

  const generate = useCallback(
    (record: DeploymentRecord) => {
      setIsGenerating(true);
      setResult(null);
      setError(null);
      generateRollback.mutate(
        { deploymentId: record.id },
        {
          onSuccess: (res) => {
            setIsGenerating(false);
            setResult({
              id: res.packageId,
              sourceDeploymentId: record.id,
              manifestYaml: res.manifestYaml,
              componentCount: res.components.length + res.destructiveComponents.length,
              createdAt: new Date().toISOString(),
            });
          },
          onError: (err) => {
            setIsGenerating(false);
            setError(err.message);
          },
        },
      );
    },
    [generateRollback],
  );

  return { generate, isGenerating, result, error, reset: () => { setResult(null); setError(null); } };
}
