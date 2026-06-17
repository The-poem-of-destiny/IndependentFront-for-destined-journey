import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom not needed — we use fake-indexeddb which works in node
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    globals: true,
  },
});
