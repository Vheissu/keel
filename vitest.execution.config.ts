import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/execution/**/*.test.ts'], testTimeout: 150000, hookTimeout: 60000 },
});
