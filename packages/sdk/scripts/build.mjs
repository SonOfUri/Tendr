import { execFileSync } from 'node:child_process';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('..', import.meta.url));
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
for (const config of ['tsconfig.build.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], {
    cwd,
    stdio: 'inherit',
  });
}
await mkdir(new URL('../dist/cjs', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/cjs/package.json', import.meta.url), '{"type":"commonjs"}\n');
