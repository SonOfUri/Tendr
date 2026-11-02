// Read route declarations, never import/run API code (which would connect to services).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { format, resolveConfig } from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const routeDir = resolve(root, 'apps/api/src/routes');
const output = resolve(root, 'apps/web/src/lib/api-console/routes.json');
const modules = new Map();

function moduleAt(path) {
  if (modules.has(path)) return modules.get(path);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const mod = { source, values: new Map(), imports: new Map() };
  modules.set(path, mod);
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) mod.values.set(d.name.text, d.initializer);
      }
    }
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith('.')) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          mod.imports.set(binding.name.text, {
            path: resolve(dirname(path), statement.moduleSpecifier.text.replace(/\.js$/, '.ts')),
            name: binding.propertyName?.text ?? binding.name.text,
          });
        }
      }
    }
  }
  return mod;
}

function value(node, mod, depth = 0) {
  if (!node || depth > 20) return undefined;
  const read = (n, m = mod) => value(n, m, depth + 1);
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return read(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((n) => read(n));
  if (ts.isIdentifier(node)) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      for (const statement of scope.statements ?? []) {
        if (!ts.isVariableStatement(statement)) continue;
        const declaration = statement.declarationList.declarations.find(
          (d) => ts.isIdentifier(d.name) && d.name.text === node.text,
        );
        if (declaration) return read(declaration.initializer);
      }
    }
    if (mod.values.has(node.text)) return read(mod.values.get(node.text));
    const imported = mod.imports.get(node.text);
    if (imported) {
      const other = moduleAt(imported.path);
      return read(other.values.get(imported.name), other);
    }
  }
  if (ts.isTemplateExpression(node)) {
    const parts = node.templateSpans.map((span) => {
      const part = read(span.expression);
      if (typeof part !== 'string')
        throw new Error(`Unresolved route: ${node.getText(mod.source)}`);
      return part + span.literal.text;
    });
    return node.head.text + parts.join('');
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = {};
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) Object.assign(result, read(prop.expression));
      if (ts.isPropertyAssignment(prop))
        result[prop.name.getText(mod.source).replace(/['"]/g, '')] = read(prop.initializer);
      if (ts.isShorthandPropertyAssignment(prop)) result[prop.name.text] = read(prop.name);
    }
    return result;
  }
  return undefined;
}

const routes = [];
for (const file of readdirSync(routeDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort()) {
  const mod = moduleAt(resolve(routeDir, file));
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(mod.source) === 'app' &&
      ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(
        node.expression.name.text,
      )
    ) {
      const method = node.expression.name.text.toUpperCase();
      const path = value(node.arguments[0], mod);
      const config = value(node.arguments[1], mod)?.config;
      if (typeof path !== 'string' || !config?.auth)
        throw new Error(
          `Unresolved route/auth in ${file}: ${node.getText(mod.source).slice(0, 160)}`,
        );
      const auth = config.auth;
      routes.push({
        id: `${method} ${path}`,
        method,
        path,
        group: file.replace(/\.ts$/, '').replace(/-/g, ' '),
        source: relative(root, mod.source.fileName),
        line: mod.source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        principals: auth === 'public' ? ['public'] : auth.principals,
        ...(auth.permission ? { permission: auth.permission } : {}),
        ...(auth.scope ? { scope: auth.scope } : {}),
        ...(auth.stepUp ? { stepUp: true } : {}),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(mod.source);
}
const json = await format(JSON.stringify(routes), {
  ...(await resolveConfig(output)),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== json)
    throw new Error(
      'API route catalog changed. Run npm run api-console:catalog --workspace=@tendr/web',
    );
} else writeFileSync(output, json);
console.log(
  `${routes.length} API routes ${process.argv.includes('--check') ? 'verified' : 'catalogued'}.`,
);
