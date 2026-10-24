import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'prisma/**/*.test.ts'],
    fileParallelism: false,
    setupFiles: ['src/test/setup-env.ts'],
  },
});
