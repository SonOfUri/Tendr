import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LocalMailMessage } from './local-mail-policy';

/** Fixed repository directory, never a request-supplied file path. */
export async function readLocalMail(
  directory = resolve(process.cwd(), '../api/.mail'),
): Promise<LocalMailMessage[]> {
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const messages: LocalMailMessage[] = [];
  const names = files
    .filter((f) => f.isFile() && /^\d{13}-[a-z_]+-\d+\.json$/.test(f.name))
    .map((f) => f.name)
    .sort()
    .reverse()
    .slice(0, 100);
  for (const id of names) {
    try {
      const file = resolve(directory, id);
      if ((await stat(file)).size > 262_144) continue;
      const msg: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      if (
        typeof m.to !== 'string' ||
        typeof m.template !== 'string' ||
        !m.data ||
        typeof m.data !== 'object' ||
        Array.isArray(m.data)
      )
        continue;
      messages.push({
        id,
        to: m.to,
        template: m.template,
        createdAt: new Date(Number(id.slice(0, 13))).toISOString(),
        ...(typeof m.subject === 'string' ? { subject: m.subject } : {}),
        ...(typeof m.text === 'string' ? { text: m.text } : {}),
        data: Object.fromEntries(
          Object.entries(m.data).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      });
    } catch {
      /* A partially written message will appear on the next refresh. */
    }
  }
  return messages;
}
