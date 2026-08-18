import { lazy, Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import type { MonacoDiffEditorProps } from './MonacoDiffEditor';

const MonacoDiffEditorInner = lazy(() => import('./MonacoDiffEditor'));

export function LazyMonacoDiff(props: MonacoDiffEditorProps) {
  return (
    <Suspense fallback={<Skeleton className="w-full" style={{ height: props.height ?? 440 }} />}>
      <MonacoDiffEditorInner {...props} />
    </Suspense>
  );
}
