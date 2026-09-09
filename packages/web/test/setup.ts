import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Unmount RTL-rendered trees between tests so component state (e.g. the
// PermissionGrid's active tab) never leaks across cases.
afterEach(() => {
  cleanup();
});

// jsdom never lays anything out, so every element reports 0x0 offset
// dimensions. TanStack Virtual (`ResultsTree`, `SelectedComponentsView`)
// measures its scroll container via `offsetWidth`/`offsetHeight` to decide
// which rows are "in view" — with a real 0, it computes an empty visible
// range and renders nothing, even with tiny test fixtures. Give every
// element a plausible fixed size so virtualized lists actually render their
// rows under jsdom.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 600 });

// jsdom implements neither the pointer-capture APIs nor `scrollIntoView` —
// Radix UI's `Select` (`components/ui/select.tsx`, used by
// `SourceTargetPicker`/`TypeFilterPanel`) calls `hasPointerCapture`/
// `setPointerCapture`/`releasePointerCapture` on the item being clicked as
// part of its own click-vs-drag disambiguation, and throws a bare
// `TypeError` under jsdom without these. Stubbed as no-ops purely so Radix's
// internal logic doesn't crash; they don't need real capture semantics for
// the interactions these tests exercise (a plain click, not a drag-select).
if (!('hasPointerCapture' in Element.prototype)) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!('setPointerCapture' in Element.prototype)) {
  Element.prototype.setPointerCapture = () => {};
}
if (!('releasePointerCapture' in Element.prototype)) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!('scrollIntoView' in Element.prototype)) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom implements no `ResizeObserver` at all — `@xyflow/react`
// (`components/dependencies/DependencyGraphView.tsx`) observes its
// container's size to size the canvas, and throws a bare
// `ReferenceError` under jsdom without this. A no-op stub is enough:
// these tests assert on rendered node/edge content, never on
// resize-driven behavior.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}
