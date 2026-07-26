import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Pinned so local-vs-UTC assertions mean something. CI runs in UTC, where an
    // unpinned "local" timezone is identical to UTC and every such test passes
    // vacuously. Santiago is UTC-4 in July, so the two genuinely disagree.
    env: { TZ: 'America/Santiago' },
  },
});
