import { DiffEditor, loader } from '@monaco-editor/react';
import * as monacoEditor from 'monaco-editor';
import { registerApexLanguage } from '@/lib/apex-monarch';
import '@/lib/monaco-environment';

// Point @monaco-editor/react at the npm-bundled monaco-editor instead of its
// default CDN loader — this is a local-first, offline-capable tool, so
// Monaco must not depend on a network fetch at runtime.
loader.config({ monaco: monacoEditor });

export interface MonacoDiffEditorProps {
  readonly original: string;
  readonly modified: string;
  readonly language?: string;
  readonly height?: string | number;
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * The actual Monaco `DiffEditor`, isolated into its own module so it can be
 * `React.lazy()`-loaded (see `LazyMonacoDiff.tsx`) — Monaco is large and
 * Apex/LWC/Aura/VF bodies are only a fraction of what a comparison surfaces,
 * so it must not be in the initial bundle.
 */
export default function MonacoDiffEditorInner({ original, modified, language = 'apex', height = 440 }: MonacoDiffEditorProps) {
  return (
    <DiffEditor
      height={height}
      original={original}
      modified={modified}
      language={language}
      beforeMount={(monaco) => registerApexLanguage(monaco)}
      theme={prefersDark() ? 'vs-dark' : 'light'}
      options={{
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
      }}
    />
  );
}
