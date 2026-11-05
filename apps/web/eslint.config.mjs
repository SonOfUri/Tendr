import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// Server-only modules: they read server secrets (lib/payment-links.ts sends WEB_INTERNAL_TOKEN).
// Without the `server-only` package, two lint rules keep them out of client bundles:
// - only server entry files (pages, layouts, route handlers, metadata images) and their own tests
//   may import them at all, so no shared helper can carry them into a client component; and
// - a file that starts with 'use client' may never import them, even where the first rule allows.
const SERVER_ONLY_IMPORT = '(^|/)lib/payment-links$|^\\.\\.?/payment-links$';
const SERVER_ONLY_MESSAGE =
  'lib/payment-links is server-only (it sends WEB_INTERNAL_TOKEN): import it only from a server page, layout, route handler or metadata image.';
const serverOnly = new RegExp(SERVER_ONLY_IMPORT);

/** Flags server-only imports in a 'use client' module. */
const noServerModuleInClient = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    // The directive prologue: the leading string-literal statements.
    let client = false;
    for (const n of context.sourceCode.ast.body) {
      if (!n.directive) break;
      if (n.directive === 'use client') client = true;
    }
    if (!client) return {};
    const check = (node, source) => {
      if (source && typeof source.value === 'string' && serverOnly.test(source.value)) {
        context.report({ node, message: `${SERVER_ONLY_MESSAGE} ('use client' file)` });
      }
    };
    return {
      ImportDeclaration: (n) => check(n, n.source),
      ExportNamedDeclaration: (n) => check(n, n.source),
      ExportAllDeclaration: (n) => check(n, n.source),
      ImportExpression: (n) => check(n, n.source),
    };
  },
};

const eslintConfig = [
  // Build output (`next dev` writes webpack runtime files here) and Playwright artifacts.
  { ignores: ['.next/**', '.next-live-console/**', 'test-results/**', 'playwright-report/**'] },
  ...compat.extends('next/core-web-vitals'),
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { tendr: { rules: { 'no-server-module-in-client': noServerModuleInClient } } },
    rules: {
      'tendr/no-server-module-in-client': 'error',
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: SERVER_ONLY_IMPORT, message: SERVER_ONLY_MESSAGE }] },
      ],
    },
  },
  {
    // Server entry files and the module's own tests.
    files: [
      'src/app/**/page.tsx',
      'src/app/**/layout.tsx',
      'src/app/**/route.ts',
      'src/app/**/route.tsx',
      'src/app/**/opengraph-image.tsx',
      'src/app/**/twitter-image.tsx',
      'src/lib/payment-links.test.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default eslintConfig;
