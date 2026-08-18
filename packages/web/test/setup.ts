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
