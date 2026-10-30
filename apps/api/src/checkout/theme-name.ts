/** `settings.display_name` of a stored published theme document, or undefined when absent. */
export function publishedDisplayName(published: unknown): string | undefined {
  if (typeof published !== 'object' || published === null) return undefined;
  const settings = (published as { settings?: unknown }).settings;
  if (typeof settings !== 'object' || settings === null) return undefined;
  const name = (settings as { display_name?: unknown }).display_name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}
