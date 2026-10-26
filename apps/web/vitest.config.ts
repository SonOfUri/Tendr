import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests only; the Playwright specs in e2e/ run with `npm run test:e2e`.
export default defineConfig({
  // Components are rendered to static markup in some tests (no DOM): the `@/` alias and JSX.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
});
