import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

/**
 * Vite has no AMD loader, so monaco-editor's default worker bootstrap
 * (which @monaco-editor/react's CDN loader normally handles) can't resolve
 * its web workers and fails with "Failed to fetch dynamically imported
 * module ... editorWebWorkerMain.js". Wiring `MonacoEnvironment.getWorker`
 * to Vite's native `?worker` import is the standard fix. Only the generic
 * editor worker is needed — this app only uses `DiffEditor` for plain/Apex
 * text, not the JSON/TS/CSS language services that need their own workers.
 * Imported once, as a side effect, from the lazy-loaded Monaco chunk so it
 * never reaches the main bundle.
 */
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
