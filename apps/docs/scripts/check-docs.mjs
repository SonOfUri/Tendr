// Fast, offline checks. Mintlify performs the MDX/OpenAPI build and anchor validation separately.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'docs.json'), 'utf8'));
const spec = JSON.parse(readFileSync(resolve(root, 'openapi.json'), 'utf8'));
const nav = [];
function walk(value) {
  if (Array.isArray(value)) return value.forEach(walk);
  if (!value || typeof value !== 'object') return;
  if (value.pages) {
    for (const p of value.pages) if (typeof p === 'string') nav.push(p);
  }
  Object.values(value).forEach(walk);
}
walk(config.navigation);
assert.equal(new Set(nav).size, nav.length, 'Navigation contains duplicate pages');
for (const page of nav)
  assert.ok(existsSync(resolve(root, `${page}.mdx`)), `Missing page: ${page}`);

const files = [];
function scan(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const p = resolve(dir, item.name);
    if (item.isDirectory()) scan(p);
    else if (item.name.endsWith('.mdx')) files.push(p);
  }
}
scan(root);
const endpoints = new Set();
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  assert.match(content.split('\n---')[0], /^title:/m, `Missing title: ${file}`);
  const operation = /^openapi: (GET|POST|PATCH|DELETE|PUT) (\S+)$/m.exec(content);
  if (operation) {
    const [, method, path] = operation;
    assert.ok(spec.paths[path]?.[method.toLowerCase()], `Unknown API operation: ${method} ${path}`);
    endpoints.add(`${method} ${path}`);
  }
  for (const match of content.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)) {
    assert.doesNotThrow(() => JSON.parse(match[1]), `Invalid JSON example: ${file}`);
  }
  for (const match of content.matchAll(/(?:\]\(|href=")\/([^"\s)#]*)(?:#[^"\s)]*)?(?:\)|")/g)) {
    const target = match[1];
    if (!target) continue;
    assert.ok(
      existsSync(resolve(root, `${target}.mdx`)) || existsSync(resolve(root, target)),
      `Missing link /${target} in ${file}`,
    );
  }
}
// Ensure the public reference cannot quietly invent or retain a removed backend route.
const routeDir = resolve(root, '../api/src/routes');
const routeCode = readdirSync(routeDir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => readFileSync(resolve(routeDir, name), 'utf8'))
  .join('\n');
let count = 0;
for (const [path, operations] of Object.entries(spec.paths)) {
  const sourcePath = path.replace(/\{([^}]+)\}/g, ':$1');
  for (const method of Object.keys(operations)) {
    const escaped = sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const route = new RegExp(`app\\.${method}(?:<[\\s\\S]*?>)?\\(\\s*['"]${escaped}['"]`);
    assert.match(routeCode, route, `No implementation for ${method.toUpperCase()} ${path}`);
    assert.ok(endpoints.has(`${method.toUpperCase()} ${path}`), `Missing endpoint page: ${path}`);
    count++;
  }
}
for (const asset of [config.logo.light, config.logo.dark, config.favicon]) {
  assert.ok(existsSync(resolve(root, asset.slice(1))), `Missing brand asset: ${asset}`);
}
assert.equal(
  config.api.playground.display,
  'simple',
  'Examples should be copyable server-side requests',
);
console.log(
  `Docs checks passed: ${nav.length} navigation pages, ${files.length} MDX files, ${count} implemented API operations; JSON examples, internal targets and branding valid.`,
);
