function requiredPublic(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

/** Public/client-safe config only. Never put secrets in NEXT_PUBLIC_*. */
export const publicEnv = {
  apiBaseUrl: requiredPublic('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:4000'),
};

/** Server-only config. */
export function serverEnv() {
  return {
    apiBaseUrl: process.env.API_BASE_URL ?? publicEnv.apiBaseUrl,
    webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
  };
}
