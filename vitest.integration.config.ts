import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globals: true,
    pool: 'forks',
    testTimeout: 30000,
  },
});