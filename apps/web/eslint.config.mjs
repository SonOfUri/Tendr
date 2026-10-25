import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // Build output (`next dev` writes webpack runtime files here) and Playwright artifacts.
  { ignores: ['.next/**', 'test-results/**', 'playwright-report/**'] },
  ...compat.extends('next/core-web-vitals'),
];

export default eslintConfig;
