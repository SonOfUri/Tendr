/** Explicit opt-in outside development; a test deployment still uses NODE_ENV=production. */
export function apiConsoleEnabled(
  environment: string | undefined,
  flag: string | undefined,
): boolean {
  if (flag !== undefined) return flag === 'true';
  return environment === 'development';
}
