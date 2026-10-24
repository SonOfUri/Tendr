import { getKeyVault } from '../keyvault/index.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { value: string; expiresAt: number }>();

/**
 * Envelope-encrypts `plaintext` and stores it in `secrets`. The secret id is the AES-GCM
 * aad, so a ciphertext cannot be moved to another row. Returns the id (the `secret_ref`).
 * Server-side only: a secret_ref must never be taken from client input.
 */
export async function putSecret(plaintext: string, purpose: string): Promise<string> {
  const id = newId('sec');
  const ciphertext = await getKeyVault().encrypt(Buffer.from(plaintext, 'utf8'), id);
  const { kek } = JSON.parse(ciphertext) as { kek: string };
  await prisma.secret.create({ data: { id, purpose, ciphertext, kek } });
  return id;
}

/** Decrypts the secret `ref`, caching the plaintext in memory for five minutes. Never log it. */
export async function getSecret(ref: string): Promise<string> {
  const now = Date.now();
  const hit = cache.get(ref);
  if (hit && hit.expiresAt > now) return hit.value;
  cache.delete(ref);
  const row = await prisma.secret.findUnique({ where: { id: ref } });
  if (!row) throw new Error(`Secret not found: ${ref}`);
  const value = Buffer.from(await getKeyVault().decrypt(row.ciphertext, row.id)).toString('utf8');
  cache.set(ref, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Test-only: drops every cached plaintext. */
export function clearSecretCache(): void {
  cache.clear();
}
