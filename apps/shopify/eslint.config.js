import js from '@eslint/js';
import react from 'eslint-plugin-react';
const globals = {
  Buffer: 'readonly',
  process: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  AbortSignal: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setTimeout: 'readonly',
  document: 'readonly',
  window: 'readonly',
};
export default [
  { ignores: ['build/**', 'node_modules/**', '.react-router/**'] },
  {
    ...js.configs.recommended,
    files: ['**/*.mjs', '**/*.js', '**/*.jsx'],
    languageOptions: { globals, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { react },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'react/jsx-uses-vars': 'error',
    },
  },
];
