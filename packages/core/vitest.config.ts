import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@vibeset/core',
    root: __dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
