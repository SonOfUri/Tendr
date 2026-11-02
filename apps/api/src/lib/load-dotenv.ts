import { existsSync, readFileSync } from 'node:fs';

/** Minimal .env loader (no dotenv dependency). Does not override existing process.env. */
export function loadDotenvFile(path: string) {
  // The isolated console launcher supplies a complete environment without provider secrets.
  if (process.env.TENDR_SKIP_DOTENV === '1') return;
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
